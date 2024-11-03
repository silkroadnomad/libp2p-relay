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
        this.isInitialized = false;
        this.initializationPromise = null;
        
        if (process.env.TELEGRAM_BOT_TOKEN !== 'disabled') {
            logger.info('Starting Telegram bot initialization...');
            this.initializationPromise = this.initialize();
        } else {
            logger.info('Telegram bot is disabled');
        }
        
        TelegramBotService.instance = this;
    }

    static getInstance() {
        if (!TelegramBotService.instance) {
            TelegramBotService.instance = new TelegramBotService();
        }
        return TelegramBotService.instance;
    }

    async initialize() {
        try {
            logger.info('Attempting to connect to Telegram...');
            const botInfo = await this.bot.getMe();
            logger.info('Telegram bot connected successfully:', {
                username: botInfo.username,
                firstName: botInfo.first_name,
                id: botInfo.id
            });
            this.isInitialized = true;
            // await this.setupBot();
        } catch (error) {
            logger.error('Failed to initialize Telegram bot:', error);
            throw error;
        }
    }

    async waitForInitialization() {
        if (process.env.TELEGRAM_BOT_TOKEN === 'disabled') return;
        
        logger.debug('Waiting for Telegram bot initialization...');
        if (this.isInitialized) {
            logger.debug('Telegram bot already initialized');
            return;
        }
        
        if (this.initializationPromise) {
            logger.debug('Waiting for initialization promise...');
            await this.initializationPromise;
            logger.debug('Initialization promise resolved');
        }
    }

    async sendMessage(message) {
        if (process.env.TELEGRAM_BOT_TOKEN === 'disabled') {
            logger.debug('Telegram bot disabled, skipping message');
            return;
        }

        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!chatId) {
            logger.warn('Telegram chat ID missing. Skipping notification.');
            return;
        }

        try {
            logger.debug('Attempting to send Telegram message...');
            await this.waitForInitialization();
            await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
            logger.debug('Telegram message sent successfully');
        } catch (error) {
            logger.error('Failed to send Telegram notification:', error);
        }
    }

    async shutdown() {
        if (this.bot) {
            this.isPolling = false;
            await this.bot.stopPolling();
        }
    }

    async setupBot() {
        try {
            // First, stop any existing polling
            if (this.isPolling) {
                await this.bot.stopPolling();
                this.isPolling = false;
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
            }

            // Check for conflicts
            const status = await this.checkBotStatus();
            if (status?.isConflicting) {
                logger.warn('Another instance is already polling. Waiting 30 seconds before retry...');
                await new Promise(resolve => setTimeout(resolve, 30000));
                return this.setupBot(); // Retry setup
            }

            if (!status?.canPoll) {
                logger.error(`Cannot start polling: ${status?.error}`);
                return;
            }

            // Clear webhook to ensure clean polling
            await this.bot.deleteWebHook();
            
            // Start polling with specific options
            this.isPolling = true;
            await this.bot.startPolling({
                restart: false,
                polling: {
                    params: {
                        timeout: 30
                    },
                    interval: 5000
                }
            });

            this.setupErrorHandlers();
            this.setupCommandHandlers();
            
            logger.info('Telegram bot polling started successfully');
        } catch (error) {
            logger.error('Failed to setup bot:', error);
            this.isPolling = false;
            // Retry setup after delay
            setTimeout(() => this.setupBot(), 30000);
        }
    }

    async restartPolling() {
        try {
            this.isPolling = false;
            await this.bot.stopPolling();
            logger.info('Waiting 5 seconds before restarting polling...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            await this.setupBot(); // Changed from startPolling to setupBot
        } catch (error) {
            logger.error('Failed to restart polling:', error);
            this.isPolling = false;
            // Retry after delay
            setTimeout(() => this.setupBot(), 30000);
        }
    }

    async checkBotStatus() {
        try {
            // First try to delete webhook to ensure clean state
            await this.bot.deleteWebHook();
            
            // Then check for updates with minimal timeout
            const updates = await this.bot.getUpdates({ 
                limit: 1, 
                timeout: 1,
                allowed_updates: [] 
            });
            
            logger.debug('Bot status check:', {
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
                logger.error('Bot status check: Another instance is actively polling');
                return { 
                    canPoll: false, 
                    isConflicting: true,
                    error: 'Another bot instance is handling updates'
                };
            }
            logger.error('Bot status check failed:', error.message);
            return { 
                canPoll: false, 
                error: error.message 
            };
        }
    }

    setupCommandHandlers() {
        this.setupStatusCommand();
        this.setupHelpCommand();
    }

    setupStatusCommand() {
        this.bot.onText(/\/status/, async (msg) => {
            const chatId = msg.chat.id;
            try {
                const statusMessage = '🤖 Relay Status:\n' +
                    `Uptime: ${process.uptime().toFixed(0)} seconds\n` +
                    `Restart Count: ${global.restartCount}/${global.MAX_RESTARTS}\n\n` +
                    '📊 Memory Usage:';
                
                await this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'HTML' });
                await this.sendMemoryStatus(chatId);
            } catch (error) {
                console.error('Error sending status:', error);
                await this.bot.sendMessage(chatId, '❌ Error getting status information');
            }
        });
    }

    setupHelpCommand() {
        this.bot.onText(/\/help/, (msg) => {
            const chatId = msg.chat.id;
            const helpMessage = 'Available commands:\n' +
                '/status - Show relay status and memory usage\n' +
                '/help - Show this help message';
            
            this.bot.sendMessage(chatId, helpMessage);
        });
    }

    setupErrorHandlers() {
        this.bot.on('polling_error', async (error) => {
            logger.error('Telegram polling error:', error);
            if (error.code === 'ETELEGRAM' && error.message.includes('Conflict')) {
                logger.warn('Telegram polling conflict detected, attempting to resolve...');
                this.isPolling = false;
                await this.bot.stopPolling();
                await new Promise(resolve => setTimeout(resolve, 5000));
                await this.setupBot();
            } else {
                logger.error(`Telegram polling error: ${error.code === 'ETELEGRAM' ? 
                    `${error.code} - ${error.response?.body?.description || error.message}` : 
                    error.message}`);
            }
        });

        this.bot.on('error', (error) => {
            logger.error('Telegram bot error:', error.message);
        });
    }

    async sendMemoryStatus(chatId) {
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
    }

    formatBytes(bytes) {
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
}

export default TelegramBotService.getInstance(); 