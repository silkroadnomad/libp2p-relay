import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import logger from './logger.js';
import os from 'os';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';

// Initialize dotenv
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_MAX_RESTARTS = 5;
const MAX_RESTARTS = Math.min(
    parseInt(process.env.MAX_RESTARTS || DEFAULT_MAX_RESTARTS, 10),
    10  // Hard upper limit
);

if (isNaN(MAX_RESTARTS)) {
    logger.error('Invalid MAX_RESTARTS value. Using default:', DEFAULT_MAX_RESTARTS);
    MAX_RESTARTS = DEFAULT_MAX_RESTARTS;
}

const RESTART_DELAY = 5000; // 5 seconds
let restartCount = 0;
let lastCrashTime = 0;

// Initialize the bot with connection logging
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Add connection status logging
bot.getMe().then((botInfo) => {
    logger.info('Telegram bot connected successfully:', {
        username: botInfo.username,
        firstName: botInfo.first_name,
        id: botInfo.id
    });
}).catch((error) => {
    logger.error('Failed to connect Telegram bot:', error.message);
});

// Add polling start logging
bot.on('polling_error', (error) => {
    logger.error('Telegram polling error:', error);
});

function formatBytes(bytes) {
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

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
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (error) {
        logger.error('Failed to send Telegram notification:', error.message);
    }
}

function startRelay() {
    logger.info('=== Initial Memory Status ===');
    logSystemMemory();
    logProcessMemory('Wrapper');
    
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
                restartCount = 0;
            }
            
            if (restartCount < MAX_RESTARTS) {
                const message = `⚠️ Relay process crashed and is restarting...\n` +
                    `Attempt: ${restartCount + 1}/${MAX_RESTARTS}\n` +
                    `Exit Code: ${code}\n` +
                    `Signal: ${signal || 'none'}\n` +
                    `Next restart in: ${RESTART_DELAY/1000} seconds`;
                
                sendTelegramMessage(message);
                
                logger.info(`Attempting restart in ${RESTART_DELAY/1000} seconds... (Attempt ${restartCount + 1}/${MAX_RESTARTS})`);
                setTimeout(() => {
                    restartCount++;
                    lastCrashTime = currentTime;
                    startRelay();
                }, RESTART_DELAY);
            } else {
                const message = `🚫 Relay process has crashed ${MAX_RESTARTS} times.\n` +
                    `Maximum restart attempts reached.\n` +
                    `Manual intervention required!`;
                
                sendTelegramMessage(message);
                
                logger.error(`Maximum restart attempts (${MAX_RESTARTS}) reached. Please check the logs and restart manually.`);
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

// Add message handlers
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        // Gather status information
        const statusMessage = '🤖 Relay Status:\n' +
            `Uptime: ${process.uptime().toFixed(0)} seconds\n` +
            `Restart Count: ${restartCount}/${MAX_RESTARTS}\n\n` +
            '📊 Memory Usage:';
            
        await bot.sendMessage(chatId, statusMessage, { parse_mode: 'HTML' });
        
        // Send memory status as a separate message
        const memoryStatus = [];
        const used = process.memoryUsage();
        memoryStatus.push('💾 Process Memory:');
        memoryStatus.push(`RSS: ${formatBytes(used.rss)}`);
        memoryStatus.push(`Heap Total: ${formatBytes(used.heapTotal)}`);
        memoryStatus.push(`Heap Used: ${formatBytes(used.heapUsed)}`);
        
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        memoryStatus.push('\n💻 System Memory:');
        memoryStatus.push(`Total: ${formatBytes(totalMem)}`);
        memoryStatus.push(`Free: ${formatBytes(freeMem)}`);
        memoryStatus.push(`Used: ${formatBytes(totalMem - freeMem)}`);
        
        await bot.sendMessage(chatId, memoryStatus.join('\n'), { parse_mode: 'HTML' });
    } catch (error) {
        logger.error('Error sending status:', error);
        await bot.sendMessage(chatId, '❌ Error getting status information');
    }
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpMessage = 'Available commands:\n' +
        '/status - Show relay status and memory usage\n' +
        '/help - Show this help message';
    
    bot.sendMessage(chatId, helpMessage);
});

// Add error handler for bot
bot.on('error', (error) => {
    logger.error('Telegram bot error:', error);
});

// Add polling_error handler
bot.on('polling_error', (error) => {
    logger.error('Telegram polling error:', error);
});

// Update the process termination handlers to also stop the bot
process.on('SIGINT', async () => {
    logger.info('Received SIGINT. Shutting down...');
    await bot.stopPolling();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM. Shutting down...');
    await bot.stopPolling();
    process.exit(0);
});

// Start the relay
startRelay(); 