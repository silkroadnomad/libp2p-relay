import { pushData } from './pushData.js'
import { crypto } from 'bitcoinjs-lib'
import { getNameOpUTXOsOfTxHash } from './getNameOpUTXOsOfTxHash.js'

/**
 * Call Electrumx and find transaction with the given nameId
 * @param electrumClient
 * @param nameToCheck
 * @returns {Promise<*[]>}
 */
export const nameShow = async (electrumClient, nameToCheck) => {

	let script = '53' + pushData(nameToCheck) + pushData(new Uint8Array([])) + '6d' + '75' + '6a';
	let hash = crypto.sha256(Buffer.from(script, 'hex'));
	let reversedHash = Buffer.from(hash.reverse()).toString("hex");
	let results = []
	await electrumClient.connect("electrum-client-js", "1.4.2");
	const result = await electrumClient.request('blockchain.scripthash.get_history', [reversedHash]);

	for (const item of result) {
		const detailResults = await getNameOpUTXOsOfTxHash(electrumClient,item.tx_hash);
		results = [...detailResults, ...results];
	}
	return results
}