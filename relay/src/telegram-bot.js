import TelegramBot from 'node-telegram-bot-api';
import logger from './logger.js';
import os from 'os';
import dotenv from 'dotenv';

// Configure dotenv at the top of the file
dotenv.config();

export class TelegramBotService {
    static instance = null;

    constructor() {
        // Ensure singleton pattern
        if (TelegramBotService.instance) {
            console.warn('TelegramBotService instance already exists! Returning existing instance.');
            return TelegramBotService.instance;
        }

        if (process.env.TELEGRAM_BOT_TOKEN === 'disabled') {
            console.log('Telegram bot is disabled');
            TelegramBotService.instance = this;
            return;
        }

        this.instanceId = `${process.pid}-${Date.now()}`;
        console.log(`Initializing new TelegramBotService instance ${this.instanceId}`);
        
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
            polling: {
                params: {
                    timeout: 30
                },
                interval: 5000,
                autoStart: false
            }
        });

        this.isPolling = false;
        this.setupBot();
        
        TelegramBotService.instance = this;
    }

    static getInstance() {
        if (!TelegramBotService.instance) {
            TelegramBotService.instance = new TelegramBotService();
        }
        return TelegramBotService.instance;
    }

    async checkBotStatus() {
        try {
            // Try to get updates with minimal timeout
            // If another instance is polling, this will fail with a conflict error
            const updates = await this.bot.getUpdates({ 
                limit: 1, 
                timeout: 1,
                allowed_updates: [] 
            });
            
            console.log('Bot status check:', {
                canPoll: true,
                currentlyPolling: this.isPolling,
                updatesAvailable: updates.length > 0
            });

            return {
                canPoll: true,
                isPolling: this.isPolling
            };
        } catch (error) {
            if (error.code === 'ETELEGRAM' && error.message.includes('Conflict')) {
                console.error('Bot status check: Another instance is actively polling');
                return { 
                    canPoll: false, 
                    isConflicting: true,
                    error: 'Another bot instance is handling updates'
                };
            }
            console.error('Bot status check failed:', error.message);
            return { 
                canPoll: false, 
                error: error.message 
            };
        }
    }

    async setupBot() {
        // Check bot status before starting
        const status = await this.checkBotStatus();
        
        if (status?.isConflicting) {
            console.error('Another instance is already polling. Waiting 30 seconds before retry...');
            await new Promise(resolve => setTimeout(resolve, 30000));
            await this.setupBot(); // Retry setup
            return;
        }

        if (!status?.canPoll) {
            console.error(`Cannot start polling: ${status?.error}`);
            return;
        }

        // Start polling if status check passed
        await this.startPolling();

        this.bot.on('polling_error', async (error) => {
            if (error.code === 'ETELEGRAM' && error.message.includes('Conflict')) {
                console.warn('Telegram polling conflict detected, checking status...');
                const status = await this.checkBotStatus();
                
                if (status?.isConflicting) {
                    console.error('Confirmed: Another bot instance is actively polling');
                    // Optional: implement a maximum retry count here
                } else {
                    console.warn('No active conflict detected, restarting polling in 5 seconds...');
                    await this.restartPolling();
                }
            } else if (error.code === 'ETELEGRAM') {
                console.error(`Telegram polling error: ${error.code} - ${error.response?.body?.description || error.message}`);
            } else {
                console.error(`Telegram polling error: ${error.message}`);
            }
        });

        // Connection status logging
        this.bot.getMe().then((botInfo) => {
            logger.info('Telegram bot connected successfully:', {
                username: botInfo.username,
                firstName: botInfo.first_name,
                id: botInfo.id
            });
        }).catch((error) => {
            console.error('Failed to connect Telegram bot:', error.message);
        });

        // Error handlers
        this.bot.on('error', (error) => {
            console.error('Telegram bot error:', error.message);
        });

        // Command handlers
        this.setupCommandHandlers();
    }

    async startPolling() {
        if (this.isPolling) return;
        
        try {
            this.isPolling = true;
            await this.bot.startPolling({ restart: false });
        } catch (error) {
            console.error('Failed to start polling:', error.message);
            this.isPolling = false;
        }
    }

    async restartPolling() {
        try {
            await this.bot.stopPolling();
            this.isPolling = false;
            // Increase wait time before restart from 1s to 5s
            console.log('Waiting 5 seconds before restarting polling...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            await this.startPolling();
        } catch (error) {
            console.error('Failed to restart polling:', error.message);
            this.isPolling = false;
        }
    }

    async shutdown() {
        if (this.bot) {
            this.isPolling = false;
            await this.bot.stopPolling();
        }
    }

    setupCommandHandlers() {
        this.bot.onText(/\/status/, async (msg) => {
            const chatId = msg.chat.id;
            try {
                const statusMessage = '🤖 Relay Status:\n' +
                    `Uptime: ${process.uptime().toFixed(0)} seconds\n` +
                    `Restart Count: ${global.restartCount}/${global.MAX_RESTARTS}\n\n` +
                    '📊 Memory Usage:';
                
                await this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'HTML' });
                
                const memoryStatus = [];
                const used = process.memoryUsage();
                memoryStatus.push('💾 Process Memory:');
                memoryStatus.push(`RSS: ${this.formatBytes(used.rss)}`);
                memoryStatus.push(`Heap Total: ${this.formatBytes(used.heapTotal)}`);
                memoryStatus.push(`Heap Used: ${this.formatBytes(used.heapUsed)}`);
                
                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                memoryStatus.push('\n💻 System Memory:');
                memoryStatus.push(`Total: ${this.formatBytes(totalMem)}`);
                memoryStatus.push(`Free: ${this.formatBytes(freeMem)}`);
                memoryStatus.push(`Used: ${this.formatBytes(totalMem - freeMem)}`);
                
                await this.bot.sendMessage(chatId, memoryStatus.join('\n'), { parse_mode: 'HTML' });
            } catch (error) {
                console.error('Error sending status:', error);
                await this.bot.sendMessage(chatId, '❌ Error getting status information');
            }
        });

        this.bot.onText(/\/help/, (msg) => {
            const chatId = msg.chat.id;
            const helpMessage = 'Available commands:\n' +
                '/status - Show relay status and memory usage\n' +
                '/help - Show this help message';
            
            this.bot.sendMessage(chatId, helpMessage);
        });
    }

    async sendMessage(message) {
        // Skip if bot is disabled or not initialized
        if (process.env.TELEGRAM_BOT_TOKEN === 'disabled' || !this.bot) {
            return;
        }

        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!chatId) {
            console.warn('Telegram chat ID missing. Skipping notification.');
            return;
        }

        try {
            await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error('Failed to send Telegram notification:', error.message);
        }
    }

    formatBytes(bytes) {
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
}

// Export a singleton instance instead of creating a new one each time
export default TelegramBotService.getInstance(); 