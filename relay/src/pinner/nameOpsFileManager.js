import fs from 'fs/promises'
import path from 'path'
import { unixfs } from '@helia/unixfs'
import logger from '../logger.js'
import { CID } from 'multiformats/cid'

const CID_STORAGE_DIR = path.join(process.cwd(), 'data', 'nameops_cids')

/**
 * Updates the daily name operations file in IPFS.
 * 
 * @async
 * @function updateDailyNameOpsFile
 * @param {Array<Object>} nameOpUtxos - Array of name operation UTXOs to be added.
 * @param {Helia} helia - The Helia IPFS client instance.
 * @param {string} blockDate - The date of the block in YYYY-MM-DD format.
 * @param {number} blockHeight - The height of the block.
 * @returns {Promise<string>} A promise that resolves with the CID of the updated file.
 * @throws {Error} If there's an issue with IPFS operations.
 */
export async function updateDailyNameOpsFile(nameOpUtxos, helia, blockDate, blockHeight) {
    console.log("updateDailyNameOpsFile", nameOpUtxos.length, helia !== undefined, blockDate, blockHeight)
    console.log("blockDate", blockDate)
    const fileName = `nameops-${blockDate}.json`
    const filePath = path.join(CID_STORAGE_DIR, fileName)

    const heliaFs = unixfs(helia)
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    let existingNameOps = []
    try {
        await fs.mkdir(CID_STORAGE_DIR, { recursive: true })
        const existingCid = await fs.readFile(filePath, 'utf-8')
        if (existingCid) {
            const chunks = []
            for await (const chunk of heliaFs.cat(CID.parse(existingCid))) {
                chunks.push(chunk)
            }
            const existingContent = decoder.decode(Buffer.concat(chunks))
            existingNameOps = JSON.parse(existingContent)
        }
    } catch (error) {
        logger.info(`No existing file found or error reading file: ${error.message}`)
    }

    const allNameOps = [...existingNameOps, ...nameOpUtxos]
    const uniqueNameOps = Array.from(new Set(allNameOps.map(JSON.stringify))).map(JSON.parse)

    const content = JSON.stringify(uniqueNameOps, null, 2)

    const cid = await heliaFs.addBytes(encoder.encode(content))
    logger.info(`File added to IPFS with CID: ${cid}`,allNameOps)

    try {
        await fs.writeFile(filePath, cid.toString())
        logger.info(`CID written to local file: ${filePath}`)
    } catch (error) {
        logger.error(`Error writing CID to local file: ${error.message}`)
    }

    return cid.toString()
}
