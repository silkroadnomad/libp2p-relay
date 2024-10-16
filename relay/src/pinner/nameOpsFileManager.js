import { unixfs } from '@helia/unixfs'
import { updateScanningState } from './scanningStateManager.js'
import logger from '../logger.js'

/**
 * Updates the daily name operations file in IPFS and publishes it to IPNS.
 * 
 * @async
 * @function updateDailyNameOpsFile
 * @param {Array<Object>} nameOpUtxos - Array of name operation UTXOs to be added.
 * @param {Helia} helia - The Helia IPFS client instance.
 * @param {IPNS} ipnsInstance - The IPNS instance for publishing.
 * @param {PrivateKey} ipnsPrivateKey - The private key for IPNS publishing.
 * @param {string} blockDate - The date of the block in YYYY-MM-DD format.
 * @param {number} blockHeight - The height of the block.
 * @param {string} blockHash - The hash of the block.
 * @returns {Promise<void>} A promise that resolves when the update is complete.
 * @throws {Error} If there's an issue with IPFS operations or IPNS publishing.
 * 
 * @description
 * This function performs the following operations:
 * 1. Attempts to read existing name operations for the given date.
 * 2. Merges new name operations with existing ones.
 * 3. Adds the updated content to IPFS.
 * 4. Publishes the new CID to IPNS.
 * 5. Updates the scanning state with the latest block information.
 */
export async function updateDailyNameOpsFile(nameOpUtxos, helia, ipnsInstance, ipnsPrivateKey, blockDate, blockHeight, blockHash) {
    console.log("updateDailyNameOpsFile", nameOpUtxos.length, helia !== undefined, ipnsPrivateKey !== undefined, blockDate)
    const fileName = `nameops-${blockDate}.json`;

    const fs = unixfs(helia)
    const encoder = new TextEncoder()

    let existingNameOps = []
    let existingMetadata = { firstBlockHeight: blockHeight, firstBlockHash: blockHash, lastBlockHeight: blockHeight, lastBlockHash: blockHash }
    try {
        const publicKeyHex = Buffer.from(ipnsPrivateKey.publicKey.raw).toString('hex');
        console.log("Attempting to resolve IPNS path, public key (hex):", publicKeyHex);
        const resolvedPath = await ipnsInstance.resolve(ipnsPrivateKey.publicKey);
        console.log("IPNS path resolved:", resolvedPath);

        console.log("Attempting to read content from resolved CID")
        const chunks = []
        for await (const chunk of fs.cat(resolvedPath.cid)) {
            chunks.push(chunk)
        }
        const existingContent = new TextDecoder().decode(Buffer.concat(chunks))
        const parsedContent = JSON.parse(existingContent)
        existingNameOps = parsedContent.nameOps
        existingMetadata = parsedContent.metadata
        logger.info(`Existing file found and read for ${fileName}`)
    } catch (error) {
        console.error("Error during IPNS resolution or content reading:", error)
        if (error.code === 'ERR_NOT_FOUND') {
            logger.info(`No existing IPNS record found for ${fileName}, starting fresh`)
        } else {
            logger.warn(`Error reading existing file for ${fileName}, starting fresh`, { error: error.message })
        }
    }

    existingMetadata.lastBlockHeight = blockHeight
    existingMetadata.lastBlockHash = blockHash
    if (blockHeight < existingMetadata.firstBlockHeight) {
        existingMetadata.firstBlockHeight = blockHeight
        existingMetadata.firstBlockHash = blockHash
    }

    const mergedNameOps = [...existingNameOps, ...nameOpUtxos]
    const uniqueNameOps = Array.from(new Set(mergedNameOps.map(JSON.stringify))).map(JSON.parse)

    const content = JSON.stringify({
        metadata: existingMetadata,
        nameOps: uniqueNameOps
    }, null, 2)

    const cid = await fs.addBytes(encoder.encode(content))
    logger.info(`File added to IPFS with CID: ${cid} with content `)

    const publicKey = ipnsPrivateKey.publicKey;

    if (!publicKey) {
        logger.error('Error: ipnsPrivateKey.public is undefined');
        logger.info('ipnsPrivateKey:', ipnsPrivateKey);
        return;
    }

    if (!ipnsInstance) {
        logger.error('Error: ipnsInstance is undefined');
        return;
    }

    const value = cid.toString()
    const key = ipnsPrivateKey 

    try {
        console.log("Attempting to publish to IPNS")
        await ipnsInstance.publish(key, value)
        logger.info(`IPNS updated for key ${key.toString('hex')} to point to CID: ${value}`)

        console.log("Verifying IPNS publication")
        const resolvedPath = await ipnsInstance.resolve(ipnsPrivateKey.publicKey)
        logger.info("IPNS resolution after publication:", resolvedPath)
    } catch (error) {
        console.error('Error during IPNS publication or verification:', error)
        logger.error('Error publishing to IPNS:', error)
        logger.info('key:', key)
        logger.info('value:', value)
    }

    await updateScanningState(existingMetadata)
}
