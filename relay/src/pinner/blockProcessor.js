import moment from 'moment/moment.js'
import logger from '../logger.js'

export async function processBlockAtHeight(height, electrumClient) {
    let counter = 0;
    let blockDate;
    let nameOpUtxos = [];

    while (true) {
        try {
            const tx = await electrumClient.request('blockchain.transaction.id_from_pos', [height, counter]);
            const txDetails = await electrumClient.request('blockchain.transaction.get', [tx, true]);
            blockDate = new Date(txDetails.blocktime * 1000); // Convert UNIX timestamp to JavaScript Date object
            logger.info(`Processing block at height ${height}, position ${counter}`, { txid: txDetails.txid.toString('hex') })
            for (const vout of txDetails.vout) {
                const asm = vout.scriptPubKey.asm
                const asmParts = asm.split(" ")
                if (asmParts[0] === 'OP_10' || asmParts[0] === 'OP_NAME_DOI') {
                    logger.info(`nameOp found: ${vout.scriptPubKey.nameOp.name}`)
                    logger.info(`value: ${vout.scriptPubKey.nameOp.value}`)
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
            logger.warn(`Warning: Error processing transaction at height ${height}, position ${counter}: ${ex.message}`);
            await new Promise(resolve => setTimeout(resolve, 500));
            counter++;
        }
    }

    return { nameOpUtxos, blockDate };
}
