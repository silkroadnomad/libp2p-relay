import 'dotenv/config'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
// External libraries
import moment from 'moment'
import { CID } from "multiformats/cid"
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys'
// Libp2p and related modules
import { createLibp2p } from 'libp2p'
// Helia and related modules
import { createHelia } from 'helia'
import { unixfs } from "@helia/unixfs"
import { bitswap } from '@helia/block-brokers'
import { libp2pRouting } from '@helia/routers'


// Storage modules
import { LevelBlockstore } from "blockstore-level"
import { LevelDatastore } from "datastore-level"

// Local modules
import logger from './logger.js'
import { connectElectrum } from "./doichain/connectElectrum.js"
import { getLastNameOps } from "./pinner/nameOpsFileManager.js"
import { getNameOpsCidsForDate } from "./pinner/scanBlockchainForNameOps.js"
import { scanBlockchainForNameOps } from '../src/pinner/scanBlockchainForNameOps.js'
import { retryFailedCIDs } from './pinner/scanBlockchainForNameOps.js'

import fs from 'fs/promises'
import { setTimeout } from 'timers/promises'

import { createHttpServer } from './httpServer.js'
import { createOrbitDB } from '@orbitdb/core'
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

let blockstore = new LevelBlockstore("./helia-blocks")
let datastore = new LevelDatastore("./helia-data")


let scoreThresholds = {}
if(relayDevMode) scoreThresholds = {
	gossipThreshold: -Infinity,
	publishThreshold: -Infinity,
	graylistThreshold: -Infinity,
}
const network = { name: 'doichain-mainnet' }; // Replace with actual network object
const electrumClient = await connectElectrum(network, (x,y)=>{})


async function createNode () {
	// Convert the raw private key to a key object
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
            bitswap()  // Only use bitswap, skip gateways
        ],
        routers: [
            libp2pRouting(libp2p)  // Only use libp2p routing
        ],
		// Configure GC options
		config: {
			gc: {
				enabled: true,          // Enable automatic GC
				interval: 1000 * 60 * 60, // Run GC every hour
				gracePeriod: '48h',     // Keep blocks for at least 48 hours after last access
			}
		}
	})

	// Create OrbitDB instance
	const orbitdb = await createOrbitDB({ ipfs: helia })
	logger.info('OrbitDB initialized')

	console.log('Helia peerId:', helia.libp2p.peerId.toString())
	console.log('Configured listen addresses:', listenAddresses)
	console.log('Actual listen addresses:', helia.libp2p.getMultiaddrs().map(ma => ma.toString()))

	return { helia, orbitdb }
}

const { helia, orbitdb } = await createNode()
logger.info('Helia and OrbitDB are running')
//when a peer connecs we need to update the peer list
helia.libp2p.addEventListener('peer:connect', async event => {
    //await retryFailedCIDs(helia, orbitdb)
})
const fsHelia = unixfs(helia)

helia.libp2p.services.pubsub.subscribe(CONTENT_TOPIC)

helia.libp2p.services.pubsub.addEventListener('message', async event => {
    logger.info(`Received pubsub message from ${event.detail.from} on topic ${event.detail.topic}`)
    const topic = event.detail.topic
    const from = event.detail.from

    if (topic.startsWith(CONTENT_TOPIC)) {
        const message = new TextDecoder().decode(event.detail.data)
        logger.info(`Received pubsub message from ${from} on topic ${topic}`)

        if(message.startsWith("NEW-CID")){
            const cid = message.substring(8)
            const addingMsg = "ADDING-CID:"+cid
            console.log("publishing query in ipfs:", addingMsg)
            helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(addingMsg))
            console.log("querying published")

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
        } else if (message.startsWith("LIST_")) {
            console.log("Received LIST request:");
            const dateString = message.substring(5); // Extract the date part
            
            if (dateString === "LAST_100") {
                console.log("Fetching last 100 name_ops");
                const lastNameOps = await getLastNameOps(orbitdb, 100);
                if (lastNameOps.length > 0) {
                    console.log(`Publishing last ${lastNameOps.length} NameOps`);
                    const jsonString = JSON.stringify(lastNameOps);
                    helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(jsonString));
                } else {
                    console.log("No NameOps found");
                    helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("LAST_100_CIDS:NONE"));
                }
            } else {
                
                let date;
                if (dateString === "TODAY") {
                    date = moment.utc().toDate();
                } else {
                    date = moment.utc(dateString, 'YYYY-MM-DD').startOf('day').toDate();
                }

                if (isNaN(date.getTime())) {
                    console.log("Invalid date format received");
                    helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("INVALID_DATE_FORMAT"));
                } else {
                    const foundNameOps = await getNameOpsCidsForDate(helia, date);
                    const formattedDate = date.toISOString().split('T')[0]; // Format as YYYY-MM-DD
                    if (foundNameOps.length > 0) {
                        console.log(`Publishing NameOps for ${formattedDate}:`, foundNameOps);
                        const jsonString = JSON.stringify(foundNameOps);
                        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(jsonString));
                    } else {
                        console.log(`No NameOps found for ${formattedDate}`);
                        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(`${formattedDate}_CIDS:NONE`));
                    }
                }
            }
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

async function retryFailedCIDsWithAttempts(helia, maxAttempts = 3, timeWindow = 5000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await retryFailedCIDs(helia, orbitdb);
            console.log(`Attempt ${attempt}: Successfully retried failed CIDs`);
            return; // Exit the function if successful
        } catch (error) {
            console.error(`Attempt ${attempt}: Failed to retry CIDs`, error);
            if (attempt < maxAttempts) {
                const delay = timeWindow;
                console.log(`Waiting ${delay}ms before next attempt...`);
                await setTimeout(delay);
            }
        }
    }
    console.error(`Failed to retry CIDs after ${maxAttempts} attempts`);
}

//await retryFailedCIDsWithAttempts(helia, orbitdb);


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
    
    // REMOVE this old direct call:
    // await scanBlockchainForNameOps(electrumClient, helia, orbitdb);
    
    // ADD this new TipWatcher logic:
    const tipWatcher = new TipWatcher(electrumClient);
    
    tipWatcher.on('newTip', async () => {
        try {
            await scanBlockchainForNameOps(electrumClient, helia, orbitdb);
        } catch (error) {
            logger.error('Error scanning blockchain:', error);
        }
    });
    
    await tipWatcher.start();
    logger.info('TipWatcher started');
} else {
    logger.info('Blockchain scanning is disabled')
}

// Add cleanup for OrbitDB
process.on('SIGINT', async () => {
    logger.info('Shutting down...')
    if (orbitdb) {
        await orbitdb.stop()
    }
    process.exit(0)
})

process.on('SIGTERM', async () => {
    logger.info('Shutting down...')
    if (orbitdb) {
        await orbitdb.stop()
    }
    process.exit(0)
})

createHttpServer(helia, orbitdb)

