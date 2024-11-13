import logger from '../logger.js'
import localforage from 'localforage'

const STATE_DB_NAME = 'scanning-state'
let stateDB = null

async function getStateDB() {
    if (!stateDB) {
        logger.info('Opening scanning state database...')
        stateDB = localforage.createInstance({
            name: STATE_DB_NAME,
            storeName: 'scanning_state',
            // Use file storage for Node.js
            driver: process.versions?.node ? require('localforage-node-driver') : localforage.INDEXEDDB
        })
        logger.info('Database loaded')
    }
    return stateDB
}

export async function updateScanningState(_, metadata) {
    try {
        const db = await getStateDB()
        await db.setItem('current_state', {
            ...metadata,
            updatedAt: new Date().toISOString()
        })
        
        // Verify the write
        const verification = await db.getItem('current_state')
        return verification
    } catch (error) {
        logger.error('Error updating scanning state', { 
            error: error.message,
            stack: error.stack,
            metadata 
        })
        throw error
    }
}

export async function getScanningState(_) {
    try {
        const db = await getStateDB()
        const state = await db.getItem('current_state')
        
        if (state && state.lastBlockHeight && state.tipHeight) {
            logger.info('Retrieved existing scanning state', { 
                lastBlockHeight: state.lastBlockHeight, 
                tipHeight: state.tipHeight 
            })
            return state
        }
        
        logger.warn('No existing scanning state found, starting from the latest block')
        return null
    } catch (error) {
        logger.error('Error reading scanning state', { 
            error: error.message,
            stack: error.stack 
        })
        return null
    }
}

export async function closeStateDB() {
    if (stateDB) {
        await stateDB.dropInstance()
        stateDB = null
    }
}
