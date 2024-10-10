import moment from 'moment/moment.js'
import { ipns } from '@helia/ipns'
import { CID } from 'multiformats/cid'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { unixfs } from '@helia/unixfs'

const ipnsKeys = new Map();
let helia
let ipnsInstance

/**
 * Scan blockchain via electrumx
 * @param electrumClient
 * @param maxRecords
 * @returns {Promise<void>}
 */
export async function scanBlockchainForNameOps(electrumClient,_helia, fromHeight) {
    helia = _helia
    ipnsInstance = ipns(_helia)
    console.log("ipnsInstance",ipnsInstance)
    /*fromHeight = 358976*/
    const tip =  await electrumClient.request('blockchain.headers.subscribe');
    console.log("tip",tip);
    const currentHeight = fromHeight  || tip.height
    console.log("currentHeight",currentHeight);
    let nameSpaces = []
    let quatsch = []
    let nameOpUtxos = []
    const BATCH_SIZE = 100; // Number of blocks to process in each batch
    const MIN_HEIGHT = 0; // Minimum block height to scan

    for (let height = currentHeight; height > MIN_HEIGHT; height -= BATCH_SIZE) {
        console.log(`Processing batch starting at height ${height}`);
        const batchEndHeight = Math.max(height - BATCH_SIZE + 1, MIN_HEIGHT);
        
        for (let batchHeight = height; batchHeight >= batchEndHeight; batchHeight--) {
            console.log(`Processing block at height ${batchHeight}`);
            try {
                // Process the block at this height
                await processBlockAtHeight(batchHeight, electrumClient, nameOpUtxos, nameSpaces, quatsch, helia);
            } catch (error) {
               // console.error(`Error processing block at height ${batchHeight}:`, error);
            }
        }

        // Optional: Add a delay between batches to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function processBlockAtHeight(height, electrumClient, nameOpUtxos, nameSpaces, names, helia) {
    let counter = 0;
    let blockDate;
    while (true) {
        try {
            const tx = await electrumClient.request('blockchain.transaction.id_from_pos', [height, counter]);
            const txDetails = await electrumClient.request('blockchain.transaction.get', [tx, true]);

            blockDate = moment.unix(txDetails.blocktime).format('YYYY-MM-DD');
            const ipnsKeyName = `nameops-${blockDate}`;
            let ipnsPrivateKey;

            // Check if we already have a key for this date
            if (ipnsKeys.has(ipnsKeyName)) {
                ipnsPrivateKey = ipnsKeys.get(ipnsKeyName);
            } else {
                // Generate a new key if we don't have one
                ipnsPrivateKey = await generateKeyPair('Ed25519');
                ipnsKeys.set(ipnsKeyName, ipnsPrivateKey);
            }

            for (const vout of txDetails.vout) {
                const asm = vout.scriptPubKey.asm
                const asmParts = asm.split(" ")
                if (asmParts[0] === 'OP_10' || asmParts[0] === 'OP_NAME_DOI') {
                    let _tx = {}
                    _tx.nameId = vout.scriptPubKey.nameOp.name
                    _tx.nameValue = vout.scriptPubKey.nameOp.value
                    _tx.address = vout.scriptPubKey?.addresses[0]

                    if(_tx.nameId.indexOf('/')!==-1) {
                        const newNameSpace = _tx.nameId.substring(0,_tx.nameId.indexOf('/'))
                        if(!nameSpaces.includes(newNameSpace))nameSpaces.push(newNameSpace)
                    }
                    else names.push(_tx.nameId)
                    console.log("nameId",_tx)

                    //write a file of todays nameOps and everybody who asks for it
                    //if a nameValue contains an ipfs:// url try to get the data from ipfs
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

                    // Update the daily name-ops file and publish to IPNS
                    await updateDailyNameOpsFile(nameOpUtxos, helia, ipnsPrivateKey, blockDate)

                    nameSpaces = nameSpaces
                    names = names
                    nameOpUtxos = nameOpUtxos
                }
            }
            counter++
        } catch (ex) {
            if (ex.message.includes('No such transaction')) {
                // We've processed all transactions in this block
                break;
            }
            throw ex; // Re-throw unexpected errors
        }
    }
}

async function updateDailyNameOpsFile(nameOpUtxos, helia, ipnsPrivateKey, blockDate) {
    console.log("updateDailyNameOpsFile", nameOpUtxos, helia !== undefined, ipnsPrivateKey !== undefined, blockDate)
    const fileName = `nameops-${blockDate}.json`;

    const fs = unixfs(helia)
    const encoder = new TextEncoder()

    let existingNameOps = []
    try {
        // Try to resolve the current IPNS record
        const resolvedPath = await ipnsInstance.resolve(ipnsPrivateKey.public)
        
        // Fetch the existing file content
        const chunks = []
        for await (const chunk of fs.cat(CID.parse(resolvedPath))) {
            chunks.push(chunk)
        }
        const existingContent = new TextDecoder().decode(Buffer.concat(chunks))
        existingNameOps = JSON.parse(existingContent)
        console.log(`Existing file found and read for ${fileName}`)
    } catch (error) {
        console.log(`No existing file found for ${fileName}, starting fresh`)
    }

    // Merge existing name-ops with new ones, avoiding duplicates
    const mergedNameOps = [...existingNameOps, ...nameOpUtxos]
    const uniqueNameOps = Array.from(new Set(mergedNameOps.map(JSON.stringify))).map(JSON.parse)

    const content = JSON.stringify(uniqueNameOps, null, 2)
    console.log("content", content)

    // Add the file to IPFS using Helia and UnixFS
    const cid = await fs.addBytes(encoder.encode(content))
    console.log(`File added to IPFS with CID: ${cid}`)

    // Get the public key from the private key
    const publicKey = ipnsPrivateKey.public;

    // Update IPNS to point to the new CID
    await ipnsInstance.publish(publicKey, cid)
    console.log(`IPNS updated for key ${publicKey.toString()} to point to CID: ${cid}`)
}