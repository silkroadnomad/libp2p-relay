import { processBlockAtHeight } from './blockProcessor.js'
import { updateDailyNameOpsFile } from './nameOpsFileManager.js'
import { getScanningState, updateScanningState } from './scanningStateManager.js'
import logger from '../logger.js'
import moment from 'moment/moment.js'
import { CID } from 'multiformats/cid'
import { unixfs } from '@helia/unixfs'
import { getOrGenerateKey } from './ipnsKeyManager.js'

let helia
let ipnsInstance

export async function scanBlockchainForNameOps(electrumClient, _helia, _ipnsInstance) {
    logger.info("scanBlockchainForNameOps")
    helia = _helia
    ipnsInstance = _ipnsInstance

    const tip = await electrumClient.request('blockchain.headers.subscribe');
    logger.info("Blockchain tip", { height: tip.height });

    let state = await getScanningState()
    let startHeight;
    let currentDay = null;
    let currentDayIpnsKey = null;

    if (state && state.tipHeight) {
        if (tip.height > state.tipHeight) {
            // New blocks have been added since last scan
            startHeight = tip.height;
            logger.info("New blocks detected, starting from current tip", { startHeight, storedTip: state.tipHeight });
        } else {
            // No new blocks, continue from where we left off
            startHeight = state.lastBlockHeight;
            logger.info("Continuing from last scanned block", { startHeight });
        }
    } else {
        // No previous state, start from current tip
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
            // Check if we've moved to a new day
            const blockDay = moment(blockDate).format('YYYY-MM-DD');
            if (blockDay !== currentDay) {
                currentDay = blockDay;
                logger.info(`Processing blocks for ${currentDay}`);
                const ipnsKeyName = `nameops-${currentDay}`;
                currentDayIpnsKey = await getOrGenerateKey(ipnsKeyName);
            }

            if (nameOpUtxos.length > 0) {
                logger.debug(`Found ${nameOpUtxos.length} name operations in block ${height}`);
                await updateDailyNameOpsFile(nameOpUtxos, helia, ipnsInstance, currentDayIpnsKey, blockDate, height, blockHash);
            } else {
                logger.debug(`No name operations found in block ${height}`);
            }
            
            // Update the scanning state after each block
            await updateScanningState({ lastBlockHeight: height, tipHeight: tip.height })

            // If we've reached the old tip, jump to the last processed block
            if (state && state.tipHeight && height === state.tipHeight) {
                height = state.lastBlockHeight + 1; // +1 because the loop will decrement it
                logger.info(`Reached old tip, jumping to last processed block`, { height: state.lastBlockHeight });
            }
        } catch (error) {
            logger.error(`Error processing block at height ${height}:`, { error });
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Add a small delay between blocks to avoid overwhelming the node
        await new Promise(resolve => setTimeout(resolve, 100));

        // Every BATCH_SIZE blocks, pause for a longer time
        if (height % BATCH_SIZE === 0) {
            logger.info(`Completed batch. Pausing for 5 seconds before next batch.`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

export async function getTodayNameOpsCids(helia, ipnsInstance) {
    logger.info("Getting today's NameOps CIDs")
    
    // Get today's date in the format YYYY-MM-DD
    const today = moment().format('YYYY-MM-DD');
    const ipnsKeyName = `nameops-${today}`;

    try {
        // Get the IPNS private key for today
        const ipnsPrivateKey = await getOrGenerateKey(ipnsKeyName);

        const fs = unixfs(helia)

        // Resolve the IPNS name to get the latest CID
        const resolvedPath = await ipnsInstance.resolve(ipnsPrivateKey.publicKey)
        logger.info(`Resolved IPNS path: ${resolvedPath}`)

        // Retrieve the content from IPFS
        const chunks = []
        for await (const chunk of fs.cat(CID.parse(resolvedPath))) {
            chunks.push(chunk)
        }
        const content = new TextDecoder().decode(Buffer.concat(chunks))
        
        // Parse the content
        const parsedContent = JSON.parse(content)
        
        if (!parsedContent || !Array.isArray(parsedContent)) {
            logger.info("No NameOps found in the retrieved content")
            return []
        }
        
        // The content should already be today's NameOps, so we can return all CIDs
        const todayCids = parsedContent.map(op => op.txid)
        
        logger.info(`Found ${todayCids.length} NameOps for today`, { date: today })
        
        return todayCids
    } catch (error) {
        logger.error("Error retrieving today's NameOps CIDs", { error: error.message })
        return []
    }
}

export async function getNameOpsCidsForDate(helia, ipnsInstance, date) {
    const formattedDate = date.toISOString().split('T')[0]; // Format as YYYY-MM-DD
    logger.info(`Getting NameOps CIDs for ${formattedDate}`)
    
    const ipnsKeyName = `nameops-${formattedDate}`;
    try {
        // Get the IPNS private key for the specified date
        const ipnsPrivateKey = await getOrGenerateKey(ipnsKeyName);
        logger.info(`Found ipnsPublicKey ${ipnsPrivateKey.publicKey}`)
        
        let resolvedPath;
        try {
            // Resolve the IPNS name to get the latest CID
            resolvedPath = await ipnsInstance.resolve(ipnsPrivateKey.publicKey)
            logger.info(`Resolved IPNS path: ${resolvedPath}`)
        } catch (resolveError) {
            if (resolveError.message.includes('Could not find record for routing key')) {
                logger.info(`No IPNS record found for ${formattedDate}. This is normal for future dates or dates with no operations.`)
                return []
            }
            throw resolveError; // Re-throw if it's a different error
        }

        const fs = unixfs(helia)

        // Retrieve the content from IPFS
        const chunks = []
        for await (const chunk of fs.cat(CID.parse(resolvedPath))) {
            chunks.push(chunk)
        }
        const content = new TextDecoder().decode(Buffer.concat(chunks))
        
        // Parse the content
        const parsedContent = JSON.parse(content)
        
        if (!parsedContent || !Array.isArray(parsedContent)) {
            logger.info(`No NameOps found for ${formattedDate}`)
            return []
        }
        
        // Extract the txids from the parsed content
        const dateCids = parsedContent.map(op => op.txid)
        
        logger.info(`Found ${dateCids.length} NameOps for ${formattedDate}`)
        
        return dateCids
    } catch (error) {
        logger.error(`Error retrieving NameOps CIDs for ${formattedDate}`, { error: error.message })
        return []
    }
}
