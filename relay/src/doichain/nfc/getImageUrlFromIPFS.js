import { unixfs } from '@helia/unixfs'

export const getImageUrlFromIPFS = async (helia,tokenURI) => {
	let cid
	if (tokenURI.startsWith('ipfs://') || tokenURI.startsWith('ipns://')) {
		cid = tokenURI.split('//')[1];
	}
	console.log("loading image from cid",cid)
	const fs = unixfs(helia)
	const chunks = []
	for await (const chunk of fs.cat(cid)) {
		chunks.push(chunk)
	}
	const blob = new Blob(chunks, { type: "image/jpeg" }) // adjust the type according to your image
	return URL.createObjectURL(blob)
}