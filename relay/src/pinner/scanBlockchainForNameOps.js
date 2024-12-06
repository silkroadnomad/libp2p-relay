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

const CONTENT_TOPIC = '/doichain/nft/1.0.0'

export async function scanBlockchainForNameOps(electrumClient, helia, orbitdb) {
    logger.info("scanBlockchainForNameOps into orbitdb", orbitdb.id)
    helia = helia

    const tip = await electrumClient.request('blockchain.headers.subscribe');
    logger.info("Blockchain tip", { height: tip.height });

    let state = await getScanningState(orbitdb)
    let startHeight;
    if (state && state && state.tipHeight) {
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

    await processBlocks(helia, electrumClient, startHeight, tip, state, orbitdb);
}

async function processBlocks(helia, electrumClient, startHeight, tip, origState, orbitdb) {
    const BATCH_SIZE = 100;
    const MIN_HEIGHT = 0;
    let currentDay = null;
    let state = null;

    // Create a new PQueue instance with a concurrency limit
    const queue = new PQueue({ concurrency: 5 });

    for (let height = startHeight; height > MIN_HEIGHT; height--) {
        try {
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

                // Use the queue to manage the updateDailyNameOpsFile operation
                await queue.add(() => updateDailyNameOpsFile(orbitdb, nameOpUtxos, blockDay, height));

                for (const nameOp of nameOpUtxos) {
                    if (nameOp.nameValue && nameOp.nameValue.startsWith('ipfs://')) {
                        queue.add(() => pinIpfsContent(helia, orbitdb, nameOp.nameId, nameOp.nameValue)
                            .then(() => {
                                logger.info(`Successfully pinned IPFS content: ${nameOp.nameValue}`);
                            })
                            .catch(error => {
                                logger.error(`Failed to pin IPFS content: ${nameOp.nameValue}`, { error });
                            })
                        );
                    }
                }
            } else {
                logger.debug(`No name operations found in block ${height}`);
            }
            
            state = await updateScanningState(orbitdb, { lastBlockHeight: height, tipHeight: tip.height });
            
            // Check if we have reached the stored tipHeight
            if (state && origState && state.tipHeight && height == origState.tipHeight) {
                logger.info(`Reached stored tipHeight, jumping to last processed block`, { height: origState.lastBlockHeight });
                height = origState.lastBlockHeight; // Set height to one above lastBlockHeight to continue scanning
            }
        } catch (error) {
            logger.error(`Error processing block at height ${height}:`, { error });
            if (error.message.includes('ElectrumX connection')) {
                logger.warn("ElectrumX connection lost, attempting to reconnect...");
                await reconnectElectrumClient(electrumClient);
                height++; // Retry the current block
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retrying
            }
        }

        await new Promise(resolve => setTimeout(resolve, 100));

        if (height % BATCH_SIZE === 0) {
            logger.info(`Completed batch. Pausing for 5 seconds before next batch.`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    // Wait for all queued tasks to complete
    await queue.onIdle();
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

async function pinIpfsContent(helia, orbitdb, nameId, ipfsUrl) {
    const cid = ipfsUrl.replace('ipfs://', '')
    try {
        logger.info(`Attempting to retrieve IPFS metadata content with CID: ${cid}`);
        
        // Notify network that we're starting to pin
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNING-CID:" + cid))
        
        const fs = unixfs(helia)
        
        // Try to retrieve the content
        let content = ''
        for await (const chunk of fs.cat(CID.parse(cid))) {
            content += new TextDecoder().decode(chunk)
        }
        
        // If we've reached here, content retrieval was successful
        logger.info(`Successfully retrieved IPFS metadata content: ${cid}`);

        // Now we can pin the content
        logger.info(`Pinning IPFS metadata content with CID: ${cid}`);
        await helia.pins.add(CID.parse(cid));
        logger.info(`Successfully pinned IPFS metadata content: ${cid}`);
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNED-CID:" + cid))

        try {
            const metadata = JSON.parse(content);
            logger.info(`Retrieved metadata for CID: ${cid}`);

            // Get and pin image from metadata
            const imageUrl = await getImageUrlFromIPFS(helia, metadata.image);
            if (imageUrl && imageUrl.startsWith('ipfs://')) {
                const imageCid = imageUrl.replace('ipfs://', '');
                try {
                    // First, get existing pins before adding image
                    const existingImagePins = []
                    for await (const pin of helia.pins.ls()) {
                        try {
                            const chunks = []
                            for await (const chunk of fs.cat(pin.cid)) {
                                chunks.push(chunk)
                            }
                            existingImagePins.push({
                                cid: pin.cid.toString(),
                                content: new TextDecoder().decode(Buffer.concat(chunks))
                            })
                        } catch (error) {
                            logger.warn(`Could not read content for existing image pin ${pin.cid.toString()}:`, error)
                        }
                    }

                    // Try to retrieve the image
                    logger.info(`Attempting to retrieve image with CID: ${imageCid}`);
                    for await (const chunk of fs.cat(CID.parse(imageCid))) {
                        // We don't need to store the image content, just verify we can retrieve it
                    }
                    
                    // If retrieval is successful, pin the image
                    logger.info(`Pinning image with CID: ${imageCid}`);
                    await helia.pin.add(CID.parse(imageCid));
                    logger.info(`Successfully pinned image: ${imageCid}`);
                    helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNED-CID:" + imageCid))
                } catch (imageError) {
                    logger.error(`Failed to retrieve or pin image: ${imageCid} for nameId: ${nameId}`, { error: imageError.message, nameId });
                    throw imageError
                }
            }
        } catch (metadataError) {
            logger.error(`Error processing metadata for CID: ${cid} and nameId: ${nameId}`, { error: metadataError.message, nameId });
            throw metadataError
        }
    } catch (error) {
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("FAILED-PIN:" + cid))
        logger.error(`Error retrieving or processing IPFS content: ${cid} for nameId: ${nameId}`, { error: error.message, nameId });
        throw error
    }
}