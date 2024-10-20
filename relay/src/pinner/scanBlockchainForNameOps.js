import { processBlockAtHeight } from './blockProcessor.js'
import { updateDailyNameOpsFile } from './nameOpsFileManager.js'
import { getScanningState, updateScanningState } from './scanningStateManager.js'
import logger from '../logger.js'
import moment from 'moment/moment.js'
import { CID } from 'multiformats/cid'
import { unixfs } from '@helia/unixfs'
import fs from 'fs/promises'
import path from 'path'
import { getMetadataFromIPFS } from '../doichain/nfc/getMetadataFromIPFS.js'
import { getImageUrlFromIPFS } from '../doichain/nfc/getImageUrlFromIPFS.js'

let helia

// Global array to store failed CIDs
const failedCIDs = [];

const FAILED_CIDS_FILE = path.join(process.cwd(), 'data', 'failed_cids.json')

// Function to add a failed CID to the JSON file
async function addFailedCID(failedCID) {
    try {
        let failedCIDs = []
        try {
            const data = await fs.readFile(FAILED_CIDS_FILE, 'utf8')
            failedCIDs = JSON.parse(data)
        } catch (error) {
            // File doesn't exist or is empty, start with an empty array
        }

        // Convert array to Set to remove duplicates, then back to array
        const uniqueFailedCIDs = Array.from(new Set(failedCIDs.map(cid => JSON.stringify(cid))))
            .map(jsonString => JSON.parse(jsonString));

        // Add the new failedCID if it's not already in the array
        if (!uniqueFailedCIDs.some(cid => cid.cid === failedCID.cid)) {
            uniqueFailedCIDs.push(failedCID)
        }

        await fs.writeFile(FAILED_CIDS_FILE, JSON.stringify(uniqueFailedCIDs, null, 2))
        logger.info(`Updated failed CIDs file. Total unique CIDs: ${uniqueFailedCIDs.length}`)
    } catch (error) {
        logger.error(`Error updating failed CIDs file: ${error.message}`)
    }
}

// Function to read failed CIDs from the JSON file
async function getFailedCIDs() {
    try {
        const data = await fs.readFile(FAILED_CIDS_FILE, 'utf8')
        return JSON.parse(data)
    } catch (error) {
        logger.error(`Error reading failed CIDs from file: ${error.message}`)
        return []
    }
}

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
            // const blockHash = await electrumClient.request('blockchain.block.header', [height]);
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
                
                for (const nameOp of nameOpUtxos) {
                    if (nameOp.nameValue && nameOp.nameValue.startsWith('ipfs://')) {
                        pinIpfsContent(nameOp.nameId,nameOp.nameValue).then(() => {
                            logger.info(`Successfully pinned IPFS content: ${nameOp.nameValue}`);
                        }).catch(error => {
                            logger.error(`Failed to pin IPFS content: ${nameOp.nameValue}`, { error });
                        });
                    }
                }
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
    logFailedCIDs();
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

async function pinIpfsContent(nameId,ipfsUrl) {
    const cid = ipfsUrl.replace('ipfs://', '');
    try {
        logger.info(`Attempting to retrieve IPFS content with CID: ${cid}`);
        const fs = unixfs(helia)
        
        // Try to retrieve the content
        let content = ''
        for await (const chunk of fs.cat(CID.parse(cid))) {
            content += new TextDecoder().decode(chunk)
        }
        
        // If we've reached here, content retrieval was successful
        logger.info(`Successfully retrieved IPFS content: ${cid}`);

        // Now we can pin the content
        logger.info(`Pinning IPFS content with CID: ${cid}`);
        await helia.pins.add(CID.parse(cid));
        logger.info(`Successfully pinned IPFS content: ${cid}`);

        try {
            const metadata = JSON.parse(content);
            logger.info(`Retrieved metadata for CID: ${cid}`);

            // Get and pin image from metadata
            const imageUrl = await getImageUrlFromIPFS(helia,metadata.image);
            if (imageUrl && imageUrl.startsWith('ipfs://')) {
                const imageCid = imageUrl.replace('ipfs://', '');
                try {
                    // First, try to retrieve the image
                    logger.info(`Attempting to retrieve image with CID: ${imageCid}`);
                    for await (const chunk of fs.cat(CID.parse(imageCid))) {
                        // We don't need to store the image content, just verify we can retrieve it
                    }
                    
                    // If retrieval is successful, pin the image
                    logger.info(`Pinning image with CID: ${imageCid}`);
                    await helia.pin.add(CID.parse(imageCid));
                    logger.info(`Successfully pinned image: ${imageCid}`);
                } catch (imageError) {
                    logger.error(`Failed to retrieve or pin image: ${imageCid} for nameId: ${nameId}`, { error: imageError.message, nameId });
                    await addFailedCID({ cid: imageCid, type: 'image', parentCid: cid, nameId });
                    throw imageError
                }
            }
        } catch (metadataError) {
            logger.error(`Error processing metadata for CID: ${cid} and nameId: ${nameId}`, { error: metadataError.message, nameId });
            await addFailedCID({ cid, type: 'metadata_processing', nameId });
            throw metadataError
        }
    } catch (error) {
        logger.error(`Error retrieving or processing IPFS content: ${cid} for nameId: ${nameId}`, { error: error.message, nameId });
        await addFailedCID({ cid, type: 'retrieval_or_pinning', nameId });
        throw error
    }
}
// Function which reads the failed CIDs from the file and tries to get and pin the content again
export async function retryFailedCIDs(_helia) {
    helia = _helia
    logger.info(`
        ██████╗ ███████╗████████╗██████╗ ██╗   ██╗██╗███╗   ██╗ ██████╗     
        ██╔══██╗██╔════╝╚══██╔══╝██╔══██╗╚██╗ ██╔╝██║████╗  ██║██╔════╝     
        ██████╔╝█████╗     ██║   ██████╔╝ ╚████╔╝ ██║██╔██╗ ██║██║  ███╗    
        ██╔══██╗██╔══╝     ██║   ██╔══██╗  ╚██╔╝  ██║██║╚██╗██║██║   ██║    
        ██║  ██║███████╗   ██║   ██║  ██║   ██║   ██║██║ ╚████║╚██████╔╝    
        ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═══╝ ╚═════╝     
                                                                            
        ███████╗ █████╗ ██╗██╗     ███████╗██████╗      ██████╗██╗██████╗ ███████╗
        ██╔════╝██╔══██╗██║██║     ██╔════╝██╔══██╗    ██╔════╝██║██╔══██╗██╔════╝
        █████╗  ███████║██║██║     █████╗  ██║  ██║    ██║     ██║██║  ██║███████╗
        ██╔══╝  ██╔══██║██║██║     ██╔══╝  ██║  ██║    ██║     ██║██║  ██║╚════██║
        ██║     ██║  ██║██║███████╗███████╗██████╔╝    ╚██████╗██║██████╔╝███████║
        ╚═╝     ╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚═════╝      ╚═════╝╚═╝╚═════╝ ╚══════╝
                                                                                 
            `);

    const failedCIDs = await getFailedCIDs();
    logger.info(`Retrying ${failedCIDs.length} failed CIDs`);

    for (const failedCID of failedCIDs) {
        logger.info(`Retrying CID: ${failedCID.cid}`);
        await pinIpfsContent(failedCID.nameId,failedCID.cid);
    }

    logger.info(`
██████╗ ███████╗████████╗██████╗ ██╗   ██╗     ██████╗ ██████╗ ███╗   ███╗██████╗ ██╗     ███████╗████████╗███████╗
██╔══██╗██╔════╝╚══██╔══╝██╔══██╗╚██╗ ██╔╝    ██╔════╝██╔═══██╗████╗ ████║██╔══██╗██║     ██╔════╝╚══██╔══╝██╔════╝
██████╔╝█████╗     ██║   ██████╔╝ ╚████╔╝     ██║     ██║   ██║██╔████╔██║██████╔╝██║     █████╗     ██║   █████╗  
██╔══██╗██╔══╝     ██║   ██╔══██╗  ╚██╔╝      ██║     ██║   ██║██║╚██╔╝██║██╔═══╝ ██║     ██╔���═     ██║   ██╔══╝  
██║  ██║███████╗   ██║   ██║  ██║   ██║       ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║     ███████╗███████╗   ██║   ███████╗
╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝        ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚══════╝╚══════╝   ╚═╝   ╚══════╝
    `);
}
// Function to log failed CIDs
async function logFailedCIDs() {
    const failedCIDs = await getFailedCIDs();
    if (failedCIDs.length > 0) {
        logger.warn(`Failed to pin ${failedCIDs.length} CIDs:`);
        failedCIDs.forEach(({ cid, type, parentCid }) => {
            if (type === 'metadata_processing' || type === 'retrieval_or_pinning') {
                logger.warn(`- Metadata CID: ${cid} (${type})`);
            } else if (type === 'image') {
                logger.warn(`- Image CID: ${cid} (from metadata ${parentCid})`);
            }
        });
    } else {
        logger.info('All CIDs were successfully pinned.');
    }
}

// Export the new functions
export { pinIpfsContent, logFailedCIDs, getFailedCIDs };

