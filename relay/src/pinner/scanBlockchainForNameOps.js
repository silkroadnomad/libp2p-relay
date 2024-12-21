import { processBlockAtHeight } from './blockProcessor.js'
import { updateDailyNameOpsFile, closeDB } from './nameOpsFileManager.js'
import { getScanningState, updateScanningState } from './scanningStateManager.js'
import logger from '../logger.js'
import moment from 'moment/moment.js'
import { CID } from 'multiformats/cid'
import { unixfs } from '@helia/unixfs'
import PQueue from 'p-queue';
import client from 'prom-client';
import { PinningService } from './pinningService.js'

const CONTENT_TOPIC = '/doichain/nft/1.0.0'
let stopToken = { isStopped: false };
let pinningService = null;
// Define custom Prometheus metrics
const nameOpsIndexedCounter = new client.Counter({
    name: 'nameops_indexed_total',
    help: 'Total number of NameOps indexed'
});

const ipfsCidsPinnedCounter = new client.Counter({
    name: 'ipfs_cids_pinned_total',
    help: 'Total number of IPFS CIDs pinned'
});

const ipfsCidsPinnedErrorCounter = new client.Counter({
    name: 'ipfs_cids_pinned_errors_total',
    help: 'Total number of IPFS CIDs pinning errors'
});

const blockProcessingDuration = new client.Histogram({
    name: 'block_processing_duration_seconds',
    help: 'Duration of block processing in seconds',
    buckets: [0.1, 0.5, 1, 2, 5, 10] // Example buckets
});

// Metrics for queue lengths are currently unused
// const updateQueueLength = new client.Gauge({
//     name: 'update_queue_length',
//     help: 'Number of tasks in the update queue'
// });
// 
// const pinQueueLength = new client.Gauge({
//     name: 'pin_queue_length',
//     help: 'Number of tasks in the pin queue'
// });

const electrumClientConnectionStatus = new client.Gauge({
    name: 'electrum_client_connection_status',
    help: 'Electrum client connection status (1 for connected, 0 for disconnected)'
});

const nameOpsPerBlock = new client.Histogram({
    name: 'nameops_per_block',
    help: 'Number of NameOps found per block',
    buckets: [0, 1, 2, 5, 10, 20, 50, 100] // Example buckets
});

const errorRate = new client.Counter({
    name: 'error_rate',
    help: 'Total number of errors encountered during block processing'
});

export async function scanBlockchainForNameOps(electrumClient, helia, orbitdb, tip, _stopToken) {
    try {
        pinningService = new PinningService(helia, orbitdb, electrumClient)
        stopToken.isStopped = _stopToken;
        logger.info("scanBlockchainForNameOps into orbitdb", orbitdb.id)

        if (!tip) {
            tip = await electrumClient.request('blockchain.headers.subscribe');
            logger.info("Blockchain tip", { height: tip.height });
        }


        let state = await getScanningState(orbitdb)
        let startHeight;
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

        await processBlocks(helia, electrumClient, startHeight, tip,state, orbitdb, stopToken);
    } finally {
        // Close DB when scanning is complete or if there's an error
        await closeDB()
    }
}

async function processBlocks(helia, electrumClient, startHeight, tip,origState, orbitdb, stopToken) {
    const MIN_HEIGHT = 0;
    let currentDay = null;
    let state = null;
    const pinQueue = new PQueue({ concurrency: 5 });

    for (let height = startHeight; height > MIN_HEIGHT; height--) {
        if (stopToken.isStopped) break;
        const endTimer = blockProcessingDuration.startTimer(); // Start timing block processing
        try {
            // Update connection status
            electrumClientConnectionStatus.set(electrumClient.getStatus() === 1 ? 1 : 0);

            if (electrumClient.getStatus() !== 1) {
                logger.warn("ElectrumX connection lost, attempting to reconnect...");
                await reconnectElectrumClient(electrumClient);
            }

            logger.info(`Processing block at height ${height}`);
            const { nameOpUtxos, blockDate } = await processBlockAtHeight(height, electrumClient);
            logger.info(`nameOpUtxos ${nameOpUtxos} at ${blockDate}`);
            const blockDay = moment.utc(blockDate).format('YYYY-MM-DD');
            if (blockDay !== currentDay) {
                currentDay = blockDay;
                logger.info(`Processing blocks for ${currentDay}`);
            }

            if (nameOpUtxos.length > 0) {
                logger.debug(`Found ${nameOpUtxos.length} name operations in block ${height}`);

                // Increment the NameOps Indexed counter
                nameOpsIndexedCounter.inc(nameOpUtxos.length);

                // Record the number of NameOps per block
                nameOpsPerBlock.observe(nameOpUtxos.length);

                // Use the updateQueue for updateDailyNameOpsFile operation
                // await updateQueue.add(() => updateDailyNameOpsFile(orbitdb, nameOpUtxos, blockDay, height));
                updateDailyNameOpsFile(orbitdb, nameOpUtxos, blockDay, height)

                for (const nameOp of nameOpUtxos) {
                    if (nameOp.nameValue && nameOp.nameValue.startsWith('ipfs://')) {
                        // Use the pinQueue for pinIpfsContent operation
                        pinQueue.add(() => pinIpfsContent(electrumClient, helia, orbitdb, nameOp, nameOp.nameId, nameOp.nameValue)
                            .then(() => {
                                logger.info(`Successfully pinned IPFS content: ${nameOp.nameValue}`);
                                // Increment the IPFS CIDs Pinned counter
                                ipfsCidsPinnedCounter.inc();
                            })
                            .catch(error => {
                                logger.error(`Failed to pin IPFS content: ${nameOp.nameValue}`, { error });
                                // Increment the IPFS CIDs Pinned Errors counter
                                ipfsCidsPinnedErrorCounter.inc();
                            })
                        );
                    }
                }
            } else {
                logger.debug(`No name operations found in block ${height}`);
            }
            
            state = await updateScanningState(orbitdb, { lastBlockHeight: height, tipHeight: tip.height });
            
            // Check if we have reached the stored tipHeight
            if (state && origState && state.tipHeight && height === origState.tipHeight) {
                logger.info(`Reached stored tipHeight, jumping to last processed block`, { height: origState.lastBlockHeight });
                height = origState.lastBlockHeight; // Set height to one above lastBlockHeight to continue scanning
                state = await updateScanningState(orbitdb, { lastBlockHeight: height, tipHeight: tip.height });
            }

            // Update queue lengths
            // updateQueueLength.set(updateQueue.size);
            // pinQueueLength.set(pinQueue.size);
        } catch (error) {
            logger.error(`Error processing block at height ${height}:`, { error });
            errorRate.inc(); // Increment the error rate counter
            if (error.message.includes('ElectrumX connection')) {
                logger.warn("ElectrumX connection lost, attempting to reconnect...");
                await reconnectElectrumClient(electrumClient);
                height++; // Retry the current block
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retrying
            }
        } finally {
            endTimer(); // End timing block processing
        }
    }

    // Wait for all queued tasks to complete
    // await updateQueue.onIdle();
    await pinQueue.onIdle();
}

async function reconnectElectrumClient(electrumClient) {
    let connected = false;
    while (!connected) {
        try {
            await electrumClient.connect();
            logger.info("Reconnected to ElectrumX server");
            connected = true;
        } catch (error) {
            logger.error("Failed to reconnect to ElectrumX server", { error });
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retrying
        }
    }
}


async function pinIpfsContent(electrumClient, helia, orbitdb, nameOp, nameId, ipfsUrl) {
    const cid = ipfsUrl.replace('ipfs://', '');
    let metadataContent = '';
    let totalSize = 0;
    let metadataSize = 0;

    try {
        logger.info(`Attempting to retrieve IPFS metadata content with CID: ${cid}`);
        
        // Notify network that we're starting to pin
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNING-CID:" + cid));
        
        const fs = unixfs(helia);
        
        // Measure metadata size
        for await (const chunk of fs.cat(CID.parse(cid))) {
            metadataContent += new TextDecoder().decode(chunk);
            metadataSize += chunk.length;
        }
        totalSize += metadataSize;
        
    } catch (error) {
        logger.error(`Error retrieving IPFS metadata content: ${cid}`, { error: error.message });
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("FAILED-PIN:" + cid));
        throw error;
    }

    let metadata;
    try {
        // Parse metadata
        metadata = JSON.parse(metadataContent);
        logger.info(`Metadata size: ${metadataSize} bytes`);
    } catch (error) {
        logger.error(`Error parsing metadata content: ${cid}`, { error: error.message });
        throw error;
    }

    if (metadata.image) {
        const imageCid = metadata.image.replace('ipfs://', '');
        try {
            logger.info(`Measuring file size for CID: ${imageCid}`);
            let fileSize = 0;
            
            // Measure actual file size
            for await (const chunk of fs.cat(CID.parse(imageCid))) {
                fileSize += chunk.length;
            }
            totalSize += fileSize;
            logger.info(`File size: ${fileSize} bytes`);
        } catch (error) {
            logger.error(`Failed to measure file size for CID: ${imageCid}`, { error: error.message });
            throw error;
        }
    }

    try {
        logger.info(`Total size to be pinned: ${totalSize} bytes (metadata: ${metadataSize} bytes)`);
        
        // Calculate fee and duration based on total size
        const currentBlock = await electrumClient.request('blockchain.headers.subscribe');
        const registrationBlock = nameOp.blocktime;
        
        // Get available durations and use maximum available
        const durations = pinningService.getAvailableDurations(currentBlock.height, registrationBlock);
        const durationMonths = durations.maxDuration; // Always use maximum available duration
        
        const expectedFee = pinningService.calculatePinningFee(totalSize, durationMonths);
        
        logger.info(`Using maximum available duration of ${durationMonths} months until NFT expiration`);
        logger.info(`Calculated fee for ${durationMonths} months: ${expectedFee} DOI`);

        // Pin the metadata
        await pinningService.pinContent(cid, durationMonths, metadata.paymentTxId, nameOp);
        logger.info(`Successfully pinned IPFS metadata content: ${cid}`);
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNED-CID:" + cid));

        // Pin the associated file
        if (metadata.image && metadata.image.startsWith('ipfs://')) {
            const imageCid = metadata.image.replace('ipfs://', '');
            try {
                await pinningService.pinContent(imageCid, durationMonths, metadata.paymentTxId, nameOp);
                logger.info(`Successfully pinned file: ${imageCid}`);
                helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNED-CID:" + imageCid));
            } catch (imageError) {
                logger.error(`Failed to pin file: ${imageCid} for nameId: ${nameId}`, { error: imageError.message, nameId });
                throw imageError;
            }
        }

        return {
            success: true,
            totalSize,
            metadataSize,
            fileSize: totalSize - metadataSize,
            expectedFee,
            durationMonths
        };
        
    } catch (error) {
        logger.error(`Error during pinning process for CID: ${cid}`, { error: error.message });
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("FAILED-PIN:" + cid));
        throw error;
    }
}
