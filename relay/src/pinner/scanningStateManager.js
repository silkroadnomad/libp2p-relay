import logger from '../logger.js'
import { IPFSAccessController } from '@orbitdb/core'

const STATE_DB_NAME = 'scanning-state'
let stateDB = null

async function getStateDB(orbitdb) {
    if (!stateDB) {
        logger.info('Opening scanning state database...')
        stateDB = await orbitdb.open(STATE_DB_NAME, {
            type: 'documents',
            create: true,
            overwrite: false,
            directory: './orbitdb/scanning-state',
            AccessController: IPFSAccessController({ write: ['*'] })
        })
        logger.info('Database loaded')
    }
    return stateDB
}

export async function updateScanningState(orbitdb, metadata) {
    try {
        const db = await getStateDB(orbitdb)
        await db.put({
            _id: 'current_state',
            ...metadata
        })
        const state = await db.get('current_state')
        logger.info('Scanning state updated', state)
    } catch (error) {
        logger.error('Error updating scanning state', { error: error.message })
        throw error
    }
}

export async function getScanningState(orbitdb) {
    try {
        const db = await getStateDB(orbitdb)
        const state = await db.get('current_state')
        if (state) {
            logger.info('Retrieved existing scanning state', { lastBlockHeight: state.value.lastBlockHeight, tipHeight: state.value.tipHeight })
            return state
        }
        logger.warn('No existing scanning state found, starting from the latest block')
        return null
    } catch (error) {
        logger.error('Error reading scanning state', { error: error.message })
        return null
    }
}

export async function closeStateDB() {
    if (stateDB) {
        await stateDB.close()
        stateDB = null
    }
}
