import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
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

// Initialize dotenv
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Make these global so telegram bot can access them
global.DEFAULT_MAX_RESTARTS = 5;
global.MAX_RESTARTS = Math.min(
    parseInt(process.env.MAX_RESTARTS || global.DEFAULT_MAX_RESTARTS, 10),
    10
);
global.restartCount = 0;

if (isNaN(global.MAX_RESTARTS)) {
    logger.error('Invalid MAX_RESTARTS value. Using default:', global.DEFAULT_MAX_RESTARTS);
    global.MAX_RESTARTS = global.DEFAULT_MAX_RESTARTS;
}

const RESTART_DELAY = 5000;
let lastCrashTime = 0;

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

async function sendTelegramMessage(message) {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
        logger.warn('Telegram configuration missing. Skipping notification.');
        return;
    }

    try {
        await telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (error) {
        logger.error('Failed to send Telegram notification:', error.message);
    }
}

function startRelay() {
    logger.info('=== Initial Memory Status ===');
    logSystemMemory();
    logProcessMemory('Wrapper');
    
    // Add startup notification
    const startupMessage = `🚀 LibP2P Relay Starting...\n` +
        `System Memory: ${formatBytes(os.totalmem())}\n` +
        `Max Restarts: ${global.MAX_RESTARTS}\n` +
        `Node Memory Limit: 4 GB`;
    
    telegramBot.sendMessage(startupMessage);
    
    const relayPath = resolve(__dirname, 'relay.js');
    logger.info('Starting relay process...');
    
    const nodeArgs = [
        '--max-old-space-size=4096',
        '--expose-gc',
        '--optimize-for-size',
        relayPath
    ];
    
    logger.info('Node.js Memory Configuration:', {
        maxOldSpaceSize: '4 GB'
    });
    
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
                const message = `⚠️ Relay process crashed and is restarting...\n` +
                    `Attempt: ${global.restartCount + 1}/${global.MAX_RESTARTS}\n` +
                    `Exit Code: ${code}\n` +
                    `Signal: ${signal || 'none'}\n` +
                    `Next restart in: ${RESTART_DELAY/1000} seconds`;
                
                await telegramBot.sendMessage(message);
                
                logger.info(`Attempting restart in ${RESTART_DELAY/1000} seconds... (Attempt ${global.restartCount + 1}/${global.MAX_RESTARTS})`);
                setTimeout(() => {
                    global.restartCount++;
                    lastCrashTime = currentTime;
                    startRelay();
                }, RESTART_DELAY);
            } else {
                const message = `🚫 Relay process has crashed ${global.MAX_RESTARTS} times.\n` +
                    `Maximum restart attempts reached.\n` +
                    `Manual intervention required!`;
                
                await telegramBot.sendMessage(message);
                
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

// Update shutdown handlers
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