import logger from '../logger.js'
import fs from 'fs/promises';

const isBrowser = typeof window !== 'undefined';
const filePath = './scanning-state.json';

async function getStateFromFile() {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null; // File not found, return null
        }
        throw error;
    }
}

async function saveStateToFile(state) {
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

export async function updateScanningState(metadata) {
    try {
        const state = {
            ...metadata,
            updatedAt: new Date().toISOString()
        };

        if (isBrowser) {
            localStorage.setItem('current_state', JSON.stringify(state));
        } else {
            await saveStateToFile(state);
        }

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
        let state;
        if (isBrowser) {
            const stateStr = localStorage.getItem('current_state');
            state = stateStr ? JSON.parse(stateStr) : null;
        } else {
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
