import { unixfs } from '@helia/unixfs'
import logger from '../../logger.js'

export const getImageUrlFromIPFS = async (helia, tokenURI) => {
	let cid
	if (tokenURI.startsWith('ipfs://') || tokenURI.startsWith('ipns://')) {
		cid = tokenURI.split('//')[1];
	}
	logger.info("Loading image from CID", { cid })
	const fs = unixfs(helia)
	const chunks = []
	try {
		for await (const chunk of fs.cat(cid)) {
			chunks.push(chunk)
		}
		const blob = new Blob(chunks, { type: "image/jpeg" }) // adjust the type according to your image
		const url = URL.createObjectURL(blob)
		logger.info("Successfully created object URL for image", { cid })
		return url
	} catch (error) {
		logger.error("Error loading image from IPFS", { cid, error: error.message })
		throw error
	}
}
