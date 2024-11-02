import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_RESTARTS = 5;
const RESTART_DELAY = 5000; // 5 seconds
let restartCount = 0;
let lastCrashTime = 0;

function startRelay() {
    const relayPath = resolve(__dirname, 'relay.js');
    logger.info('Starting relay process...');
    
    const relay = spawn('node', [relayPath], {
        stdio: 'inherit',
        env: process.env
    });

    relay.on('exit', (code, signal) => {
        const currentTime = Date.now();
        
        if (code !== 0) {
            logger.error(`Relay process exited with code ${code} and signal ${signal}`);
            
            // Reset restart count if last crash was more than 1 hour ago
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