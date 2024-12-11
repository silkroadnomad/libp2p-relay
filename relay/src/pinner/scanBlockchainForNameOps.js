import { processBlockAtHeight } from './blockProcessor.js'
import { updateDailyNameOpsFile } from './nameOpsFileManager.js'
import { getScanningState, updateScanningState } from './scanningStateManager.js'
import logger from '../logger.js'
import moment from 'moment/moment.js'
import { CID } from 'multiformats/cid'
import { unixfs } from '@helia/unixfs'
import fs from 'fs/promises'
import path from 'path'
import { getImageUrlFromIPFS } from '../doichain/nfc/getImageUrlFromIPFS.js'
import PQueue from 'p-queue';
import client from 'prom-client';
import { PinningService } from './pinner/pinningService.js'

const CONTENT_TOPIC = '/doichain/nft/1.0.0'
let stopToken = { isStopped: false };
const pinningService = new PinningService(helia, orbitdb, electrumClient)
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

const updateQueueLength = new client.Gauge({
    name: 'update_queue_length',
    help: 'Number of tasks in the update queue'
});

const pinQueueLength = new client.Gauge({
    name: 'pin_queue_length',
    help: 'Number of tasks in the pin queue'
});

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
    stopToken.isStopped = _stopToken;
    logger.info("scanBlockchainForNameOps into orbitdb", orbitdb.id)
    helia = helia

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
                        pinQueue.add(() => pinIpfsContent(helia, orbitdb, nameOp, nameOp.nameId, nameOp.nameValue)
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

        // await new Promise(resolve => setTimeout(resolve, 100));

        // if (height % BATCH_SIZE === 0) {
            // logger.info(`Completed batch. Pausing for 5 seconds before next batch.`);
            // await new Promise(resolve => setTimeout(resolve, 5000));
        // }
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

async function pinIpfsContent(helia, orbitdb, nameOp, nameId, ipfsUrl) {
    const cid = ipfsUrl.replace('ipfs://', '')
    try {
        logger.info(`Attempting to retrieve IPFS metadata content with CID: ${cid}`);
        
        // Notify network that we're starting to pin
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNING-CID:" + cid))
        
        const fs = unixfs(helia)
        
        // Get metadata content and size
        let metadataContent = ''
        let totalSize = 0
        let metadataSize = 0
        
        // Measure metadata size
        for await (const chunk of fs.cat(CID.parse(cid))) {
            metadataContent += new TextDecoder().decode(chunk)
            metadataSize += chunk.length
        }
        totalSize += metadataSize
        
        // Parse metadata and get associated file
        const metadata = JSON.parse(metadataContent)
        logger.info(`Metadata size: ${metadataSize} bytes`);

        // Process image/file from metadata
        if (metadata.image) {
            const imageCid = metadata.image.replace('ipfs://', '')
            try {
                logger.info(`Measuring file size for CID: ${imageCid}`);
                let fileSize = 0
                
                // Measure actual file size
                for await (const chunk of fs.cat(CID.parse(imageCid))) {
                    fileSize += chunk.length
                }
                totalSize += fileSize
                logger.info(`File size: ${fileSize} bytes`);
            } catch (error) {
                logger.error(`Failed to measure file size for CID: ${imageCid}`, error);
                throw error;
            }
        }
        
        logger.info(`Total size to be pinned: ${totalSize} bytes (metadata: ${metadataSize} bytes)`);
        
        // Calculate fee and duration based on total size
        const currentBlock = await electrumClient.request('blockchain.headers.subscribe')
        const registrationBlock = nameOp.blocktime
        
        // Get available durations and use maximum available
        const durations = pinningService.getAvailableDurations(currentBlock.height, registrationBlock)
        const durationMonths = durations.maxDuration // Always use maximum available duration
        
        const expectedFee = pinningService.calculatePinningFee(totalSize, durationMonths)
        
        logger.info(`Using maximum available duration of ${durationMonths} months until NFT expiration`);
        logger.info(`Calculated fee for ${durationMonths} months: ${expectedFee} DOI`);

        // Get the full transaction details of the nameOp
        const txDetails = await electrumClient.request('blockchain.transaction.get', [nameOp.txid, true]);
        
        // Check for payment output to relay's address
        const RELAY_ADDRESS = process.env.RELAY_PAYMENT_ADDRESS;
        const paymentOutput = txDetails.vout.find(output => 
            output.scriptPubKey?.addresses?.includes(RELAY_ADDRESS) &&
            output.n !== nameOp.n
        );

        if (!paymentOutput) {
            throw new Error(`No payment output found in transaction ${nameOp.txid}`);
        }

        // Validate payment amount
        const paymentAmount = paymentOutput.value;
        if (paymentAmount < expectedFee) {
            throw new Error(`Insufficient payment: expected ${expectedFee} DOI, got ${paymentAmount} DOI`);
        }

        logger.info(`Valid payment found: ${paymentAmount} DOI in tx ${nameOp.txid}`);

        // Pin the metadata
        await pinningService.pinContent(cid, durationMonths, metadata.paymentTxId)
        logger.info(`Successfully pinned IPFS metadata content: ${cid}`);
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNED-CID:" + cid))

        // Pin the associated file
        if (metadata.image && metadata.image.startsWith('ipfs://')) {
            const imageCid = metadata.image.replace('ipfs://', '')
            try {
                // Pin the image with the same duration as metadata
                await pinningService.pinContent(imageCid, durationMonths, metadata.paymentTxId)
                logger.info(`Successfully pinned file: ${imageCid}`);
                helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNED-CID:" + imageCid))
            } catch (imageError) {
                logger.error(`Failed to pin file: ${imageCid} for nameId: ${nameId}`, { error: imageError.message, nameId });
                throw imageError
            }
        }

        return {
            success: true,
            totalSize,
            metadataSize,
            fileSize: totalSize - metadataSize,
            expectedFee,
            durationMonths
        }
        
    } catch (error) {
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("FAILED-PIN:" + cid))
        logger.error(`Error retrieving or processing IPFS content: ${cid} for nameId: ${nameId}`, { error: error.message, nameId });
        throw error
    }
}