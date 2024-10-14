import fs from 'fs/promises'
import path from 'path'
import logger from '../logger.js'

const STATE_FILE_PATH = path.join(process.cwd(), 'scanning_state.json')

export async function updateScanningState(metadata) {
    try {
        await fs.writeFile(STATE_FILE_PATH, JSON.stringify(metadata, null, 2))
        logger.info('Scanning state updated', { lastBlockHeight: metadata.lastBlockHeight, tipHeight: metadata.tipHeight })
    } catch (error) {
        logger.error('Error updating scanning state', { error: error.message })
    }
}

export async function getScanningState() {
    try {
        const content = await fs.readFile(STATE_FILE_PATH, 'utf8')
        const state = JSON.parse(content)
        logger.info('Retrieved existing scanning state', { lastBlockHeight: state.lastBlockHeight, tipHeight: state.tipHeight })
        return state
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn('No existing scanning state found, starting from the latest block')
        } else {
            logger.error('Error reading scanning state', { error: error.message })
        }
        return null
    }
}
