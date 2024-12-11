import 'dotenv/config'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
// External libraries
import moment from 'moment'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys'
// Libp2p and related modules
import { createLibp2p } from 'libp2p'
// Helia and related modules
import { createHelia } from 'helia'
import { unixfs } from "@helia/unixfs"

import { bitswap, trustlessGateway } from '@helia/block-brokers'
import { httpGatewayRouting, libp2pRouting } from '@helia/routers'

// Storage modules
import { LevelBlockstore } from "blockstore-level"
import { LevelDatastore } from "datastore-level"

// Local modules
import logger from './logger.js'
import { connectElectrum } from "./doichain/connectElectrum.js"
import { getLastNameOps } from "./pinner/nameOpsFileManager.js"
import { getNameOpsCidsForDate } from "./pinner/scanBlockchainForNameOps.js"
import { scanBlockchainForNameOps } from '../src/pinner/scanBlockchainForNameOps.js'

import fs from 'fs/promises'

import { createHttpServer } from './httpServer.js'
import { createOrbitDB } from '@doichain/orbitdb'
import telegramBot from './telegram-bot.js';
import { createLibp2pConfig } from './libp2p-config.js'
import TipWatcher from './pinner/tipWatcher.js'

export const CONTENT_TOPIC = process.env.CONTENT_TOPIC || "/doichain-nfc/1/message/proto"

const privKeyHex = process.env.RELAY_PRIVATE_KEY
const bootstrapList = process.env.RELAY_BOOTSTRAP_LIST?.split(',')||[]
const listenAddresses = process.env.RELAY_LISTEN_ADDRESSES?.split(',') || ['/ip4/0.0.0.0/tcp/9090']
const announceAddresses = process.env.RELAY_ANNOUNCE_ADDRESSES?.split(',')
const pubsubPeerDiscoveryTopics = process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS?.split(',')||['doichain._peer-discovery._p2p._pubsub']
const relayDevMode = process.env.RELAY_DEV_MODE
const relayLocalRegTest = process.env.RELAY_LOCAL_REGTTEST

let blockstore = new LevelBlockstore("./helia-blocks")
let datastore = new LevelDatastore("./helia-data")

let scoreThresholds = {}
if(relayDevMode) scoreThresholds = {
	gossipThreshold: -Infinity,
	publishThreshold: -Infinity,
	graylistThreshold: -Infinity,
}

const network = (relayLocalRegTest===undefined || (relayLocalRegTest!==true && relayLocalRegTest!=="true"))?{ name: 'doichain-mainnet' }:{ name: 'doichain-regtest' };
console.log("starting with network:", network)
const electrumClient = await connectElectrum(network, (x,y)=>{})


async function createNode () {
	const privKeyBuffer = uint8ArrayFromString(privKeyHex, 'hex')
	const keyPair = await privateKeyFromProtobuf(privKeyBuffer)

	const libp2pConfig = createLibp2pConfig({
		keyPair,
		datastore,
		listenAddresses,
		announceAddresses,
		pubsubPeerDiscoveryTopics,
		scoreThresholds
	})

	const libp2p = await createLibp2p(libp2pConfig)

	console.log('Libp2p peerId:', libp2p.peerId.toString())

	const helia = await createHelia({
		libp2p,
		datastore,
        blockstore,
        blockBrokers: [
            trustlessGateway(),
            bitswap()
        ],
        routers: [
            libp2pRouting(libp2p),
             httpGatewayRouting()
        ],
		// blockstore: {
		// 	blocks: blockstore,
		// 	gc: {
		// 		enabled: true,          // Enable automatic GC
		// 		interval: 1000 * 60 * 60, // Run GC every hour (in milliseconds)
		// 		gracePeriod: '48h',     // Keep blocks for at least 48 hours after last access
		// 	}
		// },
		// metrics: libp2p.metrics
	})

	// Create OrbitDB instance
	const orbitdb = await createOrbitDB({ 
		ipfs: helia,
		directory: './orbitdb', // Base directory for OrbitDB data
		id: 'doichain-relay', // Optional identifier
	})
	logger.info('OrbitDB initialized')

	console.log('Helia peerId:', helia.libp2p.peerId.toString())
	console.log('Configured listen addresses:', listenAddresses)
	console.log('Actual listen addresses:', helia.libp2p.getMultiaddrs().map(ma => ma.toString()))

	return { helia, orbitdb }
}

const { helia, orbitdb } = await createNode()
logger.info('Helia and OrbitDB are running')
//when a peer connecs we need to update the peer list
const fsHelia = unixfs(helia)

helia.libp2p.services.pubsub.subscribe(CONTENT_TOPIC)

async function handleListRequest(dateString, pageSize, from, filter) {
    try {
        let nameOps;
        console.log("Handling LIST request:", { dateString, pageSize, from, filter });
        if (dateString === "LAST") {
            nameOps = await getLastNameOps(orbitdb, pageSize, from, filter);
        } else {
            const date = parseDate(dateString);
            if (!date) {
                publishMessage("INVALID_DATE_FORMAT");
                return;
            }
            nameOps = await getNameOpsCidsForDate(orbitdb, helia, date);
        }

        if (nameOps.length > 0) {
            publishMessage(JSON.stringify(nameOps));
        } else {
            publishMessage(`${dateString}_CIDS:NONE`);
        }
    } catch (error) {
        logger.error('Error fetching NameOps:', error);
        publishMessage(`ERROR:Failed to fetch NameOps: ${error.message}`);
    }
}

function parseDate(dateString) {
    if (dateString === "TODAY") {
        return moment.utc().toDate();
    }
    const date = moment.utc(dateString, 'YYYY-MM-DD').startOf('day').toDate();
    return isNaN(date.getTime()) ? null : date;
}

function publishMessage(message) {
    helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(message));
}

helia.libp2p.services.pubsub.addEventListener('message', async event => {
    logger.info(`Received pubsub message from ${event.detail.from} on topic ${event.detail.topic}`)
    const topic = event.detail.topic
    const from = event.detail.from
    const message = new TextDecoder().decode(event.detail.data)
    let messageObject;

    try {
        messageObject = JSON.parse(message);
    } catch (error) {
    }

    if (messageObject && topic.startsWith(CONTENT_TOPIC)) {
        if (messageObject.type=="LIST") {
            console.log("Received LIST request:", messageObject);
            const { dateString, pageSize, from, filter } = messageObject;
            const pageSizeValue = parseInt(pageSize, 10) || 10; // Default to 100 if not specified
            await handleListRequest(dateString, pageSizeValue, from, filter);
        }
    }
    else {
         if(message.startsWith("NEW-CID")){
            const cid = message.substring(8)
            const addingMsg = "ADDING-CID:"+cid
            console.log("publishing query in ipfs:", addingMsg)
            helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(addingMsg))
            console.log("querying published",cid)

            try {
                // Get file info
                let fileContent = '';
                let fileSize = 0;
                for await (const buf of fsHelia.cat(cid)) {
                    fileContent += new TextDecoder().decode(buf);
                    fileSize += buf.length;
                }

                // Parse the content to get metadata (assuming JSON format)
                let metadata;
                try {
                    metadata = JSON.parse(fileContent);
                } catch (e) {
                    metadata = { name: 'Unknown', description: 'No description available' };
                }

                // Format file size
                const formattedSize = formatFileSize(fileSize);

                // Determine file type from content or metadata
                const isImage = fileContent.startsWith('\xFF\xD8') || // JPEG
                              fileContent.startsWith('\x89PNG') ||    // PNG
                              fileContent.startsWith('GIF8') ||       // GIF
                              metadata.type === 'image';              // Check metadata
                
                const isText = !isImage && (
                    metadata.type === 'text' || 
                    metadata.type === 'json' ||
                    (fileContent.length < 5000 && /^[\x00-\x7F]*$/.test(fileContent)) // Basic ASCII check
                );

                // Prepare telegram message
                let telegramMessage = `📄 New File Added to IPFS\n\n` +
                    `🔗 CID: ${cid}\n` +
                    `📝 Name: ${metadata.name || 'Unknown'}\n` +
                    `📋 Description: ${metadata.description || 'No description'}\n` +
                    `📦 Size: ${formattedSize}\n` +
                    `🕒 Added: ${new Date().toISOString()}\n` +
                    `👤 Added by: ${from}`;

                if (isText) {
                    // For text files, append content (truncate if too long)
                    const maxLength = 1000; // Telegram has message length limits
                    let contentPreview = fileContent;
                    if (contentPreview.length > maxLength) {
                        contentPreview = contentPreview.substring(0, maxLength) + '...(truncated)';
                    }
                    telegramMessage += `\n\n📝 Content:\n\`\`\`\n${contentPreview}\n\`\`\``;
                    await telegramBot.sendMessage(telegramMessage, { parse_mode: 'Markdown' });
                } else if (isImage) {
                    // For images, first send the image, then send the info
                    try {
                        // Convert buffer to format suitable for Telegram
                        const imageBuffer = Buffer.from(fileContent);
                        await telegramBot.sendPhoto({ source: imageBuffer }, { caption: telegramMessage });
                    } catch (error) {
                        logger.error('Error sending image to Telegram:', error);
                        // Fallback to sending just the message if image send fails
                        await telegramBot.sendMessage(telegramMessage);
                    }
                } else {
                    // For other file types, just send the message
                    await telegramBot.sendMessage(telegramMessage);
                }

            } catch (error) {
                logger.error('Error processing file or sending notification:', error);
                await telegramBot.sendMessage(`⚠️ Error processing new file with CID: ${cid}\nError: ${error.message}`);
            }

            const addedMsg = "ADDED-CID:"+cid
            console.log("publishing", addedMsg)
            helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(addedMsg))
        }
    }
})

// Helper function to format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Add this after creating the libp2p node
helia.libp2p.services.pubsub.addEventListener('gossipsub:message', (evt) => {
	const { from, topic, data } = evt.detail
	logger.info(`Outgoing pubsub message to ${from} on topic ${topic}`, { message: new TextDecoder().decode(data) })
})

// Add error handling for WebRTC connections
helia.libp2p.addEventListener('connection:error', (evt) => {
	logger.warn(`Connection error: ${evt.detail.error.message}`)
})

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('disable-scanning', {
    alias: 'd',
    type: 'boolean',
    description: 'Disable blockchain scanning'
  })
  .option('generate-keypair', {
    alias: 'g',
    type: 'boolean',
    description: 'Generate a new Ed25519 keypair'
  })
  .help()
  .alias('help', 'h')
  .argv

if (argv['generate-keypair']) {
  try {
    const newKeyPair = await generateKeyPair('Ed25519')
    const protobufKey = privateKeyToProtobuf(newKeyPair)
    const privateKeyHex = uint8ArrayToString(protobufKey, 'hex')
    
    console.log('New private key generated. Add this to your .env file:')
    console.log(`RELAY_PRIVATE_KEY=${privateKeyHex}`)
    
    // Optionally, write to a file
    await fs.writeFile('./.env.privateKey', `RELAY_PRIVATE_KEY=${privateKeyHex}`, 'utf8')
    console.log('Private key has been saved to .env.privateKey')
    
    // Verify the key can be correctly parsed back
    const parsedKey = privateKeyFromProtobuf(uint8ArrayFromString(privateKeyHex, 'hex'))
    console.log('Verified: Key can be correctly parsed back from hex format')
    
    process.exit(0) // Exit after generating the keypair
  } catch (error) {
    console.error('Error generating keypair:', error)
    process.exit(1)
  }
}

// Near the end of the file, replace the scanBlockchainForNameOps call with:
if (!argv['disable-scanning']) {
    logger.info('Starting blockchain scanning...');
    await scanBlockchainForNameOps(electrumClient, helia, orbitdb); 
    const tipWatcher = new TipWatcher(electrumClient);
    tipWatcher.on('newTip', async (tip) => {
        try {
            console.log("newTip: ", tip);
            await scanBlockchainForNameOps(electrumClient, helia, orbitdb, tip);
        } catch (error) {
            logger.error('Error scanning blockchain:', error);
        }
    });
    
    // Add error handler for tipWatcher
    tipWatcher.on('error', async (error) => {
        logger.error('TipWatcher error:', error);
        if (electrumClient.getStatus() !== 1) {
            try {
                await electrumClient.connect();
                logger.info('Reconnected to ElectrumX after TipWatcher error');
            } catch (reconnectError) {
                logger.error('Failed to reconnect after TipWatcher error:', reconnectError);
            }
        }
    });
    
    await tipWatcher.start();
    logger.info('TipWatcher started');
} else {
    logger.info('Blockchain scanning is disabled')
}

// Cleanup handlers with current supported methods
process.on('SIGINT', async () => {
    logger.info('Shutting down...')
    try {
        if (orbitdb) {
            await orbitdb.stop()
        }
        await blockstore.close()
        await datastore.close()
        logger.info('Databases closed')
    } catch (error) {
        logger.error('Error during shutdown:', error)
    }
    process.exit(0)
})

process.on('SIGTERM', async () => {
    logger.info('Shutting down...')
    try {
        if (orbitdb) {
            await orbitdb.stop()
        }
        await blockstore.close()
        await datastore.close()
        logger.info('Databases closed')
    } catch (error) {
        logger.error('Error during shutdown:', error)
    }
    process.exit(0)
})

createHttpServer(helia, orbitdb, electrumClient)



async function pinIpfsContent(helia, orbitdb, nameId, ipfsUrl) {
    const cid = ipfsUrl.replace('ipfs://', '')
    try {
        logger.info(`Attempting to retrieve IPFS metadata content with CID: ${cid}`)
        
        // Get current block height
        const tip = await electrumClient.request('blockchain.headers.subscribe')
        const currentBlock = tip.height

        // Get registration block for the nameId
        // This would need to be implemented based on your nameId lookup logic
        const registrationBlock = await getNameRegistrationBlock(nameId)

        // Get available durations
        const durations = pinningService.getAvailableDurations(currentBlock, registrationBlock)

        // Use maximum available duration for now
        // In production, this should come from the NFT metadata or transaction
        const durationMonths = durations.maxDuration

        // Pin the content with the pinning service
        // The payment validation would need to be integrated with your payment flow
        const pinningResult = await pinningService.pinContent(cid, durationMonths, 'payment_tx_id')

        logger.info(`Successfully pinned content: ${cid}`, pinningResult)
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNED-CID:" + cid))

        return pinningResult
    } catch (error) {
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("FAILED-PIN:" + cid))
        logger.error(`Error pinning content: ${cid}`, error)
        throw error
    }
}

async function checkExpiredPins() {
    try {
        const pinnedCids = []
        for await (const pin of helia.pins.ls()) {
            pinnedCids.push(pin.cid.toString())
        }

        for (const cid of pinnedCids) {
            const shouldRemain = await pinningService.shouldRemainPinned(cid)
            if (!shouldRemain) {
                logger.info(`Unpinning expired content: ${cid}`)
                await helia.pins.rm(CID.parse(cid))
            }
        }
    } catch (error) {
        logger.error('Error checking expired pins:', error)
    }
}

setInterval(checkExpiredPins, 60 * 60 * 1000)

