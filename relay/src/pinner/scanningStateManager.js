import logger from '../logger.js'
import { Level } from 'level'

// Create a database instance
const db = new Level('scanning-state', {
    valueEncoding: 'json'  // Automatically handles JSON serialization
})

export async function updateScanningState(_, metadata) {
    try {
        const state = {
            ...metadata,
            updatedAt: new Date().toISOString()
        }
        await db.put('current_state', state)
        
        // Verify the write
        const verification = await db.get('current_state')
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
        const state = await db.get('current_state')
        
        if (state && state.lastBlockHeight && state.tipHeight) {
            logger.info('Scanning state', { 
                status: 'existing',
                lastBlockHeight: state.lastBlockHeight, 
                tipHeight: state.tipHeight 
            })
            return state
        }
        
        logger.info('Scanning state', { status: 'starting_fresh' })
        return null
    } catch (error) {
        if (error.code === 'LEVEL_NOT_FOUND') {
            logger.info('Scanning state', { status: 'starting_fresh' })
            return null
        }
        logger.error('Error reading scanning state', { 
            error: error.message,
            stack: error.stack 
        })
        return null
    }
}

export async function closeStateDB() {
    return db.close()
}
