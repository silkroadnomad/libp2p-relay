import { address, crypto, Psbt } from 'bitcoinjs-lib'
import { DOICHAIN, NETWORK_FEE, VERSION } from '../doichain.js'
import { getNameOPStackScript } from '../getNameOPStackScript.js'
import { getNameOpUTXOsOfTxHash } from '../getNameOpUTXOsOfTxHash.js'
import logger from '../../logger.js'

/**
 * Gets the unspent transaction outputs
 *
 * @param electrumClient
 * @param utxoAddress
 * @returns {Promise<*>}
 */
export const getUTXOSFromAddress = async (electrumClient, utxoAddress) => {
	if(!electrumClient || !utxoAddress) return []
	let script = address.toOutputScript(utxoAddress, DOICHAIN);
	let hash = crypto.sha256(script);
	let reversedHash = Buffer.from(hash.reverse()).toString("hex");

	logger.info("Fetching UTXOs for address", { utxoAddress, reversedHash });
	const utxos = await electrumClient.request('blockchain.scripthash.listunspent', [reversedHash]);
	logger.info(`Found ${utxos.length} UTXOs`, { utxoAddress });

	for (let i = 0; i < utxos.length; i++) {
		const utxo = utxos[i];
		logger.debug("Processing UTXO", { txHash: utxo.tx_hash, txPos: utxo.tx_pos });
		const fullTX = await getNameOpUTXOsOfTxHash(electrumClient, utxo.tx_hash, utxo.tx_pos);
		utxo.fullTx = fullTX;
	}
	return utxos
}

export const generatePSBT = async (electrumClient, selectedUtxos, nameId, nameValue, changeAddress, recipientAddress) => {
	if(selectedUtxos.length === 0) return;
	logger.info("Generating PSBT", { utxoCount: selectedUtxos.length, nameId, recipientAddress });

	const psbt = new Psbt({ network: DOICHAIN });

	let storageFee = NETWORK_FEE.satoshis;
	let doiAmount = 0;

	let totalInputAmount = 0;
	let totalOutputAmount = 0;

	for (let i = 0; i < selectedUtxos.length; i++) {
		const utxo = selectedUtxos[i];
		logger.debug("Processing UTXO for PSBT", { txHash: utxo.tx_hash, txPos: utxo.tx_pos });
		const scriptPubKeyHex = utxo.fullTx.script