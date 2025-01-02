import logger from '../logger.js'
import fs from 'fs/promises';

const isBrowser = typeof window !== 'undefined';
const filePath = './scanning-state.json';

async function getStateFromFile() {
    try {
        logger.debug('Attempting to read state from file');
        const data = await fs.readFile(filePath, 'utf-8');
        logger.debug('State read from file successfully');
        return JSON.parse(data);
    } catch (error) {
        logger.debug('Error reading state from file', { error: error.message });
        if (error.code === 'ENOENT') {
            return null; // File not found, return null
        }
        throw error;
    }
}

async function saveStateToFile(state) {
    logger.debug('Attempting to save state to file', { state });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
    logger.debug('State saved to file successfully');
}

export async function updateScanningState(metadata) {
    try {
        logger.debug('Updating scanning state', { metadata });
        const state = {
            ...metadata,
            updatedAt: new Date().toISOString()
        };

        if (isBrowser) {
            logger.debug('Saving state to localStorage');
            localStorage.setItem('current_state', JSON.stringify(state));
        } else {
            logger.debug('Saving state to file');
            await saveStateToFile(state);
        }

        logger.debug('Scanning state updated successfully', { state });
        return state;
    } catch (error) {
        logger.error('Error updating scanning state', { 
            error: error.message,
            stack: error.stack,
            metadata 
        });
        throw error;
    }
}

export async function getScanningState() {
    try {
        logger.debug('Retrieving scanning state');
        let state;
        if (isBrowser) {
            logger.debug('Reading state from localStorage');
            const stateStr = localStorage.getItem('current_state');
            state = stateStr ? JSON.parse(stateStr) : null;
        } else {
            logger.debug('Reading state from file');
            state = await getStateFromFile();
        }

        if (state && state.lastBlockHeight && state.tipHeight) {
            logger.info('Scanning state', { 
                status: 'existing',
                lastBlockHeight: state.lastBlockHeight, 
                tipHeight: state.tipHeight 
            });
            return state;
        }

        logger.info('Scanning state', { status: 'starting_fresh' });
        return null;
    } catch (error) {
        logger.error('Error reading scanning state', { 
            error: error.message,
            stack: error.stack 
        });
        return null;
    }
}

export async function closeStateDB() {
    // No action needed for localStorage or file-based storage
}
