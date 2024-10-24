import { unixfs } from '@helia/unixfs'
import logger from '../../logger.js'

/**
 * getMetadataFromIPFS
 *
 * @param helia
 * @param tokenURI the tokenUri (from Doichain Transaction)
 * @returns {Promise<any>}
 */
export async function getMetadataFromIPFS(helia, tokenURI) {
	const fs = unixfs(helia)
	const decoder = new TextDecoder()
	let text = ''
	let cid

	logger.info("Loading metadata from tokenURI", { tokenURI })

	if (tokenURI.startsWith('ipfs://') || tokenURI.startsWith('ipns://')) {
		cid = tokenURI.split('//')[1];
	} else {
		cid = tokenURI; // Assume it's already a CID if it doesn't have a protocol prefix
	}

	logger.info("Resolved CID for metadata", { cid })

	try {
		for await (const chunk of fs.cat(cid)) {
			text += decoder.decode(chunk, {
				stream: true
			})
		}
		logger.info("Successfully loaded metadata", { cid })
		logger.debug("Metadata content", { text })

		const parsedMetadata = JSON.parse(text);
		logger.info("Successfully parsed metadata JSON", { cid })
		return parsedMetadata;
	} catch (error) {
		logger.error("Error loading or parsing metadata from IPFS", { cid, error: error.message })
		throw error;
	}
}
