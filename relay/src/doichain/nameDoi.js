import { address, crypto, Psbt } from 'bitcoinjs-lib'
import { DOICHAIN, NETWORK_FEE, VERSION } from './doichain.js'
import { getNameOPStackScript } from './getNameOPStackScript.js'
import { getNameOpUTXOsOfTxHash } from './getNameOpUTXOsOfTxHash.js'

/**
 * Gets the unspent transaction outputs
 * @param electrumClient
 * @param utxoAddress
 * @returns {Promise<*>}
 */
export const getUTXOSFromAddress = async (electrumClient, utxoAddress) => {
	if(!electrumClient || !utxoAddress) return []
	let script = address.toOutputScript(utxoAddress, DOICHAIN);
	let hash = crypto.sha256(script);
	let reversedHash = Buffer.from(hash.reverse()).toString("hex");

	const utxos = await electrumClient.request('blockchain.scripthash.listunspent', [reversedHash]);
	console.log("received from electrum",utxos)
	for (let i = 0; i < utxos.length; i++) {
		const utxo = utxos[i];
		const fullTX = await getNameOpUTXOsOfTxHash(electrumClient, utxo.tx_hash, utxo.tx_pos);
		utxo.fullTx = fullTX
	}
	return utxos
}

export const generatePSBT = async (electrumClient,selectedUtxos,nameId,nameValue,changeAddress,recipientAddress) => {

	if(selectedUtxos.length===0) return
	const psbt = new Psbt({ network: DOICHAIN });

	let storageFee = NETWORK_FEE.satoshis
	let doiAmount = 0

	let totalInputAmount = 0
	let totalOutputAmount = 0;

	for (let i = 0; i < selectedUtxos.length; i++) {
		const utxo = selectedUtxos[i];
		console.log("utxo",utxo)
		const scriptPubKeyHex = utxo.fullTx.scriptPubKey.hex
		const isSegWit = scriptPubKeyHex?.startsWith('0014') || scriptPubKeyHex?.startsWith('0020');
		if (isSegWit) {
			psbt.addInput({
				hash: utxo.tx_hash,
				index: utxo.tx_pos,
				witnessUtxo: {
					script: Buffer.from(scriptPubKeyHex, 'hex'),
					value: utxo.value,
				}
			});
		} else {
			console.log("nonWitnessUtxo utxo.hex",utxo.fullTx.hex)
			psbt.addInput({
				hash: utxo.tx_hash,
				index: utxo.tx_pos,
				nonWitnessUtxo: Buffer.from(utxo.fullTx.hex,'hex')
				// nonWitnessUtxo: Buffer.from(fullTX.vout[utxo.tx_pos].hex, 'hex')
			});
		}
		totalInputAmount += utxo.value;
	}

	console.log(`recipientAddress namescript output ${doiAmount}`,recipientAddress)
	const opCodesStackScript = getNameOPStackScript(nameId,nameValue,recipientAddress, DOICHAIN)
	psbt.setVersion(VERSION) //use this for name transactions
	psbt.addOutput({
		script: opCodesStackScript,
		value: storageFee //not the doiAmount here!
	})
	totalOutputAmount += storageFee;
	let utxoCount = 1
	let transactionFee = utxoCount * 180 + 3 * 34*500
	// console.log("totalInputAmount",totalInputAmount)
	// console.log("doiAmount",doiAmount)
	// console.log("outAmount",(doiAmount+transactionFee+(nameId?storageFee:0)))

	let changeAmount = totalInputAmount - (doiAmount+transactionFee+(nameId?storageFee:0))
	console.log(`changeAddress ${changeAddress} gets`,(changeAmount))
	psbt.addOutput({
		address: changeAddress,
		value: (changeAmount),
	});
	totalOutputAmount += changeAmount;
	console.log("changeAmount:     ", changeAmount);
	console.log("Total Input  Amount:", totalInputAmount);
	console.log("Total Output Amount:", totalOutputAmount);
	const psbtBaseText = psbt.toBase64();
	console.log("psbt-file",psbtBaseText)
	return { psbtBaseText, changeAmount }
}