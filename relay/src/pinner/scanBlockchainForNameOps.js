import { processBlockAtHeight } from './blockProcessor.js'
import { updateDailyNameOpsFile } from './nameOpsFileManager.js'
import { getScanningState, updateScanningState } from './scanningStateManager.js'
import logger from '../logger.js'

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
            const { nameOpUtxos, blockDate, ipnsPrivateKey } = await processBlockAtHeight(height, blockHash, electrumClient, helia);
            if (nameOpUtxos.length > 0) {
                logger.info(`Found ${nameOpUtxos.length} name operations in block ${height}`);
                await updateDailyNameOpsFile(nameOpUtxos, helia, ipnsInstance, ipnsPrivateKey, blockDate, height, blockHash);
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
