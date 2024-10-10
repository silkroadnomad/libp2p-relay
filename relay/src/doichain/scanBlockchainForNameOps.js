export async function scanBlockchainForNameOps(maxRecords, electrumClient) {
    const currentHeight = await electrumClient.request('blockchain.headers.subscribe');
    let lowerHightBy = 0
    let newHeight, counter, outputsScanned, transactionsScanned= 0
    let currentTransaction
    let nameSpaces = []
    let quatsch = []
    let nameOpUtxos = []
    for (let height = (currentHeight.height-lowerHightBy); height > 0; height--) {
        newHeight = height
        counter=0
        try {
            while( true ){
                const tx = await electrumClient.request('blockchain.transaction.id_from_pos', [height,counter]);
                currentTransaction = tx
                const txDetails = await electrumClient.request('blockchain.transaction.get', [tx, true]);
                for (const vout of txDetails.vout) {

                    const asm = vout.scriptPubKey.asm
                    const asmParts = asm.split(" ")
                    if (asmParts[0] !== 'OP_10' && asmParts[0] !== 'OP_NAME_DOI') {
                        //_tx.address = vout.scriptPubKey?.addresses ? vout.scriptPubKey?.addresses[0] : _doiAddress
                    } else {

                        let _tx = {}
                        _tx.nameId = vout.scriptPubKey.nameOp.name
                        _tx.nameValue = vout.scriptPubKey.nameOp.value
                        _tx.address = vout.scriptPubKey?.addresses[0]

                        if(_tx.nameId.indexOf('/')!==-1) {
                            const newNameSpace = _tx.nameId.substring(0,_tx.nameId.indexOf('/'))
                            if(!nameSpaces.includes(newNameSpace))nameSpaces.push(newNameSpace)
                        }
                        else quatsch.push(_tx.nameId)

                        nameOpUtxos.push({
                            txid: txDetails.txid,
                            formattedBlocktime:  txDetails.blocktime ? moment.unix(txDetails.blocktime).format('YYYY-MM-DD HH:mm:ss') : 'mempool',
                            n: vout.n,
                            value: vout.value,
                            nameId: vout.scriptPubKey.nameOp.name,
                            nameValue: vout.scriptPubKey.nameOp.value,
                            address: vout.scriptPubKey?.addresses[0]
                        })
                        nameSpaces = nameSpaces
                        quatsch = quatsch
                        nameOpUtxos = nameOpUtxos
                    }
                    outputsScanned = outputsScanned+1
                }
                counter++
                transactionsScanned = transactionsScanned+1
                if(maxRecords && counter===maxRecords) return;
            }

        } catch(ex){ console.log("ex",ex) }
    }
}