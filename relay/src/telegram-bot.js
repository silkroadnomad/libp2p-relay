import TelegramBot from 'node-telegram-bot-api';
import logger from './logger.js';
import os from 'os';
import dotenv from 'dotenv';

// Configure dotenv at the top of the file
dotenv.config();

export class TelegramBotService {
    constructor() {
        if (process.env.TELEGRAM_BOT_TOKEN === 'disabled') {
            console.log('Telegram bot is disabled');
            return;
        }
        
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
        this.setupBot();
    }

    setupBot() {
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

        this.bot.on('polling_error', (error) => {
            // Only log the essential error information
            if (error.code === 'ETELEGRAM') {
                console.error(`Telegram polling error: ${error.code} - ${error.response?.body?.description || error.message}`);
            } else {
                console.error(`Telegram polling error: ${error.message}`);
            }
        });

        // Command handlers
        this.setupCommandHandlers();
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

    async shutdown() {
        if (this.bot) {
            await this.bot.stopPolling();
        }
    }

    formatBytes(bytes) {
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
}

export default new TelegramBotService(); 