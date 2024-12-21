import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs';
import logger from './logger.js';
import os from 'os';
import dotenv from 'dotenv';
import telegramBot from './telegram-bot.js';

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Initialize dotenv and dirname setup
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Global configurations
global.DEFAULT_MAX_RESTARTS = 5;
global.MAX_RESTARTS = Math.min(
    parseInt(process.env.MAX_RESTARTS || global.DEFAULT_MAX_RESTARTS, 10),
    10
);
global.restartCount = 0;
const RESTART_DELAY = 5000;
let lastCrashTime = 0;

// Add lock file constants
const LOCK_FILE = resolve(__dirname, '../relay.lock');

// Add lock file check and creation function
async function checkAndCreateLock() {
    try {
        // Check if lock file exists
        if (fs.existsSync(LOCK_FILE)) {
            // Read PID from lock file
            const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
            
            // Check if process with that PID is still running
            try {
                process.kill(pid, 0);
                logger.error(`Relay is already running with PID ${pid}`);
                process.exit(1);
            } catch (e) {
                // Process not running, safe to remove stale lock file
                logger.warn('Removing stale lock file');
                fs.unlinkSync(LOCK_FILE);
            }
        }
        
        // Create new lock file with current PID
        fs.writeFileSync(LOCK_FILE, process.pid.toString());
        
        // Remove lock file on process exit
        const cleanup = () => {
            try {
                if (fs.existsSync(LOCK_FILE)) {
                    fs.unlinkSync(LOCK_FILE);
                }
            } catch (error) {
                logger.error('Error removing lock file:', error);
            }
        };
        
        process.on('exit', cleanup);
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        process.on('uncaughtException', cleanup);
        
    } catch (error) {
        logger.error('Error handling lock file:', error);
        process.exit(1);
    }
}

// 1. Main relay function
async function startRelay() {
    // Check for existing instance first
    await checkAndCreateLock();
    
    logger.info('=== Initial Memory Status ===');
    logSystemMemory();
    logProcessMemory('Wrapper');
    
    // Get git commit info and prepare startup notification
    try {
        await (async () => {
            const commitInfo = await getLatestCommitInfo();
            await telegramBot.waitForInitialization();
            
            const startupMessage = `🚀 LibP2P Relay Starting...\n` +
                `System Memory: ${formatBytes(os.totalmem())}\n` +
                `Max Restarts: ${global.MAX_RESTARTS}\n` +
                `Node Memory Limit: 4 GB\n` +
                (commitInfo ? `\n📝 Latest Commit:\n` +
                    `${commitInfo.message}\n` +
                    `By: ${commitInfo.author}\n` +
                    `Hash: ${commitInfo.hash}\n` +
                    `${commitInfo.date}\n` +
                    `🔗 ${commitInfo.url}` : '');
                    console.log(startupMessage);
            
            await telegramBot.sendMessage(startupMessage);
        })();
    } catch (error) {
        logger.error('Failed to send startup notification:', error);
    }
    
    // Start the relay process immediately without waiting for Telegram
    const relayPath = resolve(__dirname, 'relay.js');
    logger.info('Starting relay process...');
    
    const nodeArgs = [
        '--max-old-space-size=8192',
        '--expose-gc',
        '--optimize-for-size',
        relayPath,
        ...process.argv.slice(2)
    ];
    
    logger.info('Starting relay process with args:', nodeArgs);
    
    const relay = spawn('node', nodeArgs, {
        stdio: 'inherit',
        env: {
            ...process.env,
            NODE_OPTIONS: '--max-old-space-size=4096'
        }
    });

    const memoryCheckInterval = setInterval(() => {
        logger.info('=== Current Memory Status ===');
        logSystemMemory();
        logProcessMemory('Wrapper');
    }, 5 * 60 * 1000); // Every 5 minutes

    relay.on('exit', async (code, signal) => {
        clearInterval(memoryCheckInterval);
        const currentTime = Date.now();
        
        if (code !== 0) {
            logger.error(`Relay process exited with code ${code} and signal ${signal}`);
            logSystemMemory();
            logProcessMemory('Wrapper');
            
            if (currentTime - lastCrashTime > 3600000) {
                global.restartCount = 0;
            }
            
            if (global.restartCount < global.MAX_RESTARTS) {
                // Send notification and wait for it
                try {
                    await (async () => {
                        await telegramBot.waitForInitialization();
                        const message = `⚠️ Relay process crashed and is restarting...\n` +
                            `Attempt: ${global.restartCount + 1}/${global.MAX_RESTARTS}\n` +
                            `Exit Code: ${code}\n` +
                            `Signal: ${signal || 'none'}\n` +
                            `Next restart in: ${RESTART_DELAY/1000} seconds`;
                        
                        await telegramBot.sendMessage(message);
                    })();
                } catch (error) {
                    logger.error('Failed to send crash notification:', error);
                }
                
                // Continue with restart
                logger.info(`Attempting restart in ${RESTART_DELAY/1000} seconds...`);
                setTimeout(() => {
                    global.restartCount++;
                    lastCrashTime = currentTime;
                    startRelay();
                }, RESTART_DELAY);
            } else {
                // Send final error notification and wait for it
                try {
                    await (async () => {
                        await telegramBot.waitForInitialization();
                        const message = `🚫 Relay process has crashed ${global.MAX_RESTARTS} times.\n` +
                            `Maximum restart attempts reached.\n` +
                            `Manual intervention required!`;
                        
                        await telegramBot.sendMessage(message);
                    })();
                } catch (error) {
                    logger.error('Failed to send final error notification:', error);
                }
                
                logger.error(`Maximum restart attempts (${global.MAX_RESTARTS}) reached. Please check the logs and restart manually.`);
                process.exit(1);
            }
        }
    });

    relay.on('error', (err) => {
        logger.error('Failed to start relay process:', err);
        logSystemMemory(); // Log memory status on error
        logProcessMemory('Wrapper');
    });
}

// 2. Git commit info function
async function getLatestCommitInfo() {
    try {
        const commitHash = execSync('git rev-parse --short HEAD').toString().trim();
        const commitMessage = execSync('git log -1 --pretty=%B').toString().trim();
        const commitAuthor = execSync('git log -1 --pretty=%an').toString().trim();
        const commitDate = execSync('git log -1 --pretty=%cd --date=relative').toString().trim();
        
        // Get the repository URL
        const remoteUrl = execSync('git config --get remote.origin.url').toString().trim()
            .replace(/\.git$/, '') // Remove .git suffix if present
            .replace(/^git@github\.com:/, 'https://github.com/'); // Convert SSH to HTTPS URL
        
        const commitUrl = `${remoteUrl}/commit/${commitHash}`;
        
        return {
            hash: commitHash,
            message: commitMessage,
            author: commitAuthor,
            date: commitDate,
            url: commitUrl
        };
    } catch (error) {
        logger.warn('Failed to get git commit info:', error.message);
        return null;
    }
}

// 3. Memory logging functions
function logSystemMemory() {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    
    logger.info('System Memory Status:', {
        total: formatBytes(totalMemory),
        used: formatBytes(usedMemory),
        free: formatBytes(freeMemory),
        percentUsed: ((usedMemory / totalMemory) * 100).toFixed(1) + '%'
    });
}

function logProcessMemory(prefix = 'Process') {
    const used = process.memoryUsage();
    logger.info(`${prefix} Memory Usage:`, {
        rss: formatBytes(used.rss),         // Resident Set Size - total memory allocated
        heapTotal: formatBytes(used.heapTotal), // V8's memory usage
        heapUsed: formatBytes(used.heapUsed),   // V8's memory usage
        external: formatBytes(used.external),    // C++ objects bound to JavaScript
        arrayBuffers: formatBytes(used.arrayBuffers || 0) // ArrayBuffers and SharedArrayBuffers
    });
}

// 4. Event handlers
process.on('SIGINT', async () => {
    logger.info('Received SIGINT. Shutting down...');
    await telegramBot.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM. Shutting down...');
    await telegramBot.shutdown();
    process.exit(0);
});

// Start the relay
startRelay(); 