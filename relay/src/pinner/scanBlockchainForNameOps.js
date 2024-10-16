import { processBlockAtHeight } from './blockProcessor.js'
import { updateDailyNameOpsFile } from './nameOpsFileManager.js'
import { getScanningState, updateScanningState } from './scanningStateManager.js'
import logger from '../logger.js'
import moment from 'moment/moment.js'
import { CID } from 'multiformats/cid'
import { unixfs } from '@helia/unixfs'
import fs from 'fs/promises'
import path from 'path'

let helia

export async function scanBlockchainForNameOps(electrumClient, _helia) {
    logger.info("scanBlockchainForNameOps")
    helia = _helia

    const tip = await electrumClient.request('blockchain.headers.subscribe');
    logger.info("Blockchain tip", { height: tip.height });

    let state = await getScanningState()
    let startHeight;
    let currentDay = null;

    if (state && state.tipHeight) {
        if (tip.height > state.tipHeight) {
            startHeight = tip.height;
            logger.info("New blocks detected, starting from current tip", { startHeight, storedTip: state.tipHeight });
        } else {
            startHeight = state.lastBlockHeight;
            logger.info("Continuing from last scanned block", { startHeight });
        }
    } else {
        startHeight = tip.height;
        logger.info("No previous state, starting from current tip", { startHeight });
    }

    const BATCH_SIZE = 100;
    const MIN_HEIGHT = 0;

    for (let height = startHeight; height > MIN_HEIGHT; height--) {
       logger.info(`Processing block at height ${height}`);
        try {
            const blockHash = await electrumClient.request('blockchain.block.header', [height]);
            const { nameOpUtxos, blockDate } = await processBlockAtHeight(height, electrumClient);
            logger.info(`nameOpUtxos ${nameOpUtxos} at ${blockDate}`);
            const blockDay = moment.utc(blockDate).format('YYYY-MM-DD');
            if (blockDay !== currentDay) {
                currentDay = blockDay;
                logger.info(`Processing blocks for ${currentDay}`);
            }

            if (nameOpUtxos.length > 0) {
                logger.debug(`Found ${nameOpUtxos.length} name operations in block ${height}`);
                await updateDailyNameOpsFile(nameOpUtxos, helia, blockDay, height);
            } else {
                logger.debug(`No name operations found in block ${height}`);
            }
            
            await updateScanningState({ lastBlockHeight: height, tipHeight: tip.height })

            if (state && state.tipHeight && height === state.tipHeight) {
                height = state.lastBlockHeight + 1;
                logger.info(`Reached old tip, jumping to last processed block`, { height: state.lastBlockHeight });
            }
        } catch (error) {
            logger.error(`Error processing block at height ${height}:`, { error });
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        if (height % BATCH_SIZE === 0) {
            logger.info(`Completed batch. Pausing for 5 seconds before next batch.`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

export async function getTodayNameOpsCids(helia) {
    logger.info("Getting today's NameOps CIDs")
    
    const today = moment().format('YYYY-MM-DD');

    try {
        const fs = unixfs(helia)

        // Here you would need to implement a way to retrieve the CID for today's NameOps
        // without using IPNS. This might involve storing the CID in a local database or file.
        const todayCid = await getTodayCidFromStorage(today);

        if (!todayCid) {
            logger.info("No CID found for today's NameOps")
            return []
        }

        const chunks = []
        for await (const chunk of fs.cat(CID.parse(todayCid))) {
            chunks.push(chunk)
        }
        const content = new TextDecoder().decode(Buffer.concat(chunks))
        
        const parsedContent = JSON.parse(content)
        
        if (!parsedContent || !Array.isArray(parsedContent)) {
            logger.info("No NameOps found in the retrieved content")
            return []
        }
        
        const todayCids = parsedContent.map(op => op.txid)
        
        logger.info(`Found ${todayCids.length} NameOps for today`, { date: today })
        
        return todayCids
    } catch (error) {
        logger.error("Error retrieving today's NameOps CIDs", { error: error.message })
        return []
    }
}

export async function getNameOpsCidsForDate(helia, date) {
    const formattedDate = date.toISOString().split('T')[0];
    logger.info(`Getting NameOps CIDs for ${formattedDate}`)
    
    try {
        const fs = unixfs(helia)
        const dateCid = await getCidFromStorage(formattedDate);
        if (!dateCid) {
            logger.info(`No CID found for NameOps on ${formattedDate}`)
            return []
        }

        const chunks = []
        for await (const chunk of fs.cat(CID.parse(dateCid))) {
            chunks.push(chunk)
        }
        const content = new TextDecoder().decode(Buffer.concat(chunks))
        
        const parsedContent = JSON.parse(content)
        
        if (!parsedContent || !Array.isArray(parsedContent)) {
            logger.info(`No NameOps found for ${formattedDate}`)
            return []
        }
        
        logger.info(`Found ${parsedContent.length} NameOps for ${formattedDate}`,parsedContent)
        
        return parsedContent
    } catch (error) {
        logger.error(`Error retrieving NameOps for ${formattedDate}`, { error: error.message })
        return []
    }
}

const CID_STORAGE_DIR = path.join(process.cwd(), 'data', 'nameops_cids')

async function getTodayCidFromStorage(date) {
    const fileName = `nameops-${date}.json`
    const filePath = path.join(CID_STORAGE_DIR, fileName)

    try {
        const cid = await fs.readFile(filePath, 'utf-8')
        return cid.trim() // Remove any whitespace
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`No CID file found for date: ${date}`)
            return null
        }
        console.error(`Error reading CID file: ${error.message}`)
        throw error
    }
}

async function getCidFromStorage(formattedDate) {
    const fileName = `nameops-${formattedDate}.json`
    const filePath = path.join(CID_STORAGE_DIR, fileName)

    try {
        const cid = await fs.readFile(filePath, 'utf-8')
        return cid.trim()
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`No CID file found for date: ${formattedDate}`)
            return null
        }
        console.error(`Error reading CID file: ${error.message}`)
        throw error
    }
}
