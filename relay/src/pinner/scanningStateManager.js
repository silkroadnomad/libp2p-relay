import logger from '../logger.js'
import { IPFSAccessController } from '@orbitdb/core'

const STATE_DB_NAME = 'scanning-state'
let stateDB = null

async function getStateDB(orbitdb) {
    if (!stateDB) {
        logger.info('Opening scanning state database...')
        stateDB = await orbitdb.open(STATE_DB_NAME, {
            type: 'documents',
            sync: false,
            create: true,
            directory: './orbitdb/scanning-state',
            AccessController: IPFSAccessController({ write: [orbitdb.identity.id] })
        })
        logger.info('Database loaded')
    }
    return stateDB
}

export async function updateScanningState(orbitdb, metadata) {
    try {
        const db = await getStateDB(orbitdb)
        const result = await db.put({
            _id: 'current_state',
            ...metadata,
        })
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

export async function getScanningState(orbitdb) {
    try {
        const db = await getStateDB(orbitdb)
        const state = await db.get('current_state')
        
        if (state && state.value && state.value.lastBlockHeight && state.value.tipHeight) {
            const currentState = state.value // get first matching document
            logger.info('Retrieved existing scanning state', { 
                lastBlockHeight: currentState.lastBlockHeight, 
                tipHeight: currentState.tipHeight 
            })
            return currentState
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
        await stateDB.close()
        stateDB = null
    }
}
