import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import logger from './logger.js';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_RESTARTS = 5;
const RESTART_DELAY = 5000; // 5 seconds
let restartCount = 0;
let lastCrashTime = 0;

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

    relay.on('exit', (code, signal) => {
        clearInterval(memoryCheckInterval); // Clean up interval on exit
        const currentTime = Date.now();
        
        if (code !== 0) {
            logger.error(`Relay process exited with code ${code} and signal ${signal}`);
            logSystemMemory(); // Log memory status on crash
            logProcessMemory('Wrapper');
            
            if (currentTime - lastCrashTime > 3600000) {
                restartCount = 0;
            }
            
            if (restartCount < MAX_RESTARTS) {
                logger.info(`Attempting restart in ${RESTART_DELAY/1000} seconds... (Attempt ${restartCount + 1}/${MAX_RESTARTS})`);
                setTimeout(() => {
                    restartCount++;
                    lastCrashTime = currentTime;
                    startRelay();
                }, RESTART_DELAY);
            } else {
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

// Handle wrapper process termination
process.on('SIGINT', () => {
    logger.info('Received SIGINT. Shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Received SIGTERM. Shutting down...');
    process.exit(0);
});

// Start the relay
startRelay(); 