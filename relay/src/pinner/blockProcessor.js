import moment from 'moment/moment.js'
import { getOrGenerateKey } from './ipnsKeyManager.js'

export async function processBlockAtHeight(height, blockHash, electrumClient, helia) {
    let counter = 0;
    let blockDate;
    let nameOpUtxos = [];
    let ipnsPrivateKey;

    while (true) {
        try {
            const tx = await electrumClient.request('blockchain.transaction.id_from_pos', [height, counter]);
            const txDetails = await electrumClient.request('blockchain.transaction.get', [tx, true]);

            blockDate = moment.unix(txDetails.blocktime).format('YYYY-MM-DD');
            const ipnsKeyName = `nameops-${blockDate}`;

            ipnsPrivateKey = await getOrGenerateKey(ipnsKeyName);
            for (const vout of txDetails.vout) {
                const asm = vout.scriptPubKey.asm
                const asmParts = asm.split(" ")
                if (asmParts[0] === 'OP_10' || asmParts[0] === 'OP_NAME_DOI') {
                    nameOpUtxos.push({
                        txid: txDetails.txid,
                        blocktime: txDetails.blocktime,
                        formattedBlocktime: moment.unix(txDetails.blocktime).format('YYYY-MM-DD HH:mm:ss'),
                        n: vout.n,
                        value: vout.value,
                        nameId: vout.scriptPubKey.nameOp.name,
                        nameValue: vout.scriptPubKey.nameOp.value,
                        address: vout.scriptPubKey?.addresses[0]
                    })
                }
            }
            counter++
        } catch (ex) {
            if (ex.message.includes('no tx at position') || ex.message.includes('No such transaction')) {
                break;
            }
            console.warn(`Warning: Error processing transaction at height ${height}, position ${counter}:`, ex.message);
            await new Promise(resolve => setTimeout(resolve, 500));
            counter++;
        }
    }

    return { nameOpUtxos, blockDate, ipnsPrivateKey };
}