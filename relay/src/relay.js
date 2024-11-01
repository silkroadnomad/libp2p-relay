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
import { circuitRelayTransport,circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { kadDHT } from '@libp2p/kad-dht'
import { uPnPNAT } from '@libp2p/upnp-nat'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { tls } from '@libp2p/tls'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { ping } from "@libp2p/ping";
import { autoNAT } from "@libp2p/autonat";
import { dcutr } from "@libp2p/dcutr";
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery"
import { webSockets } from '@libp2p/websockets'
import { webRTCDirect, webRTC } from '@libp2p/webrtc'
import * as filters from '@libp2p/websockets/filters'
import { multiaddr } from '@multiformats/multiaddr'
// Helia and related modules
import { createHelia, libp2pDefaults } from 'helia'
import { unixfs } from "@helia/unixfs"


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

import http from 'http'
import url from 'url'
import fs from 'fs/promises'
import { setTimeout } from 'timers/promises'

// At the top of your file, add these imports:
import { decodeMessage } from 'protons-runtime'
import { createHttpServer } from './httpServer.js'

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

	const libp2p = await createLibp2p({
		privateKey: keyPair,
		datastore,
		addresses: {
			listen: listenAddresses,
			announce: announceAddresses
		},
		connectionManager: {
			maxConnections: 1000, // Set max total connections
			minConnections: 10,   // Maintain at least this many connections
			maxIncomingPendingConnections: 100, // Max pending incoming connection requests
			maxOutgoingPendingConnections: 100, // Max pending outgoing connection requests
			pollInterval: 2000,   // How often to poll for connection updates (ms)
		},
		transports: [
			tcp(),
			//webTransport(), /* webtransport does not allow listening to webtransport https://github.com/libp2p/js-libp2p/blob/c5bbb2596273d2503e1996169bab2411546fe674/packages/transport-webtransport/README.md?plain=1#L31C1-L33C197*/
			webRTCDirect(),
			webRTC(),
			circuitRelayTransport({ discoverRelays: 1 }) ,   
			webSockets({
				filter: filters.all,
				listener: (socket) => {
					const remoteAddr = multiaddr(socket.remoteAddress).toString()
					logger.info(`WebSocket connection established with: ${remoteAddr}`)
				}
			})
			//   webSockets({
			// 	server: httpServer,
			// 	websocket: {
			// 		rejectUnauthorized: false
			// 	}
			// })
		],
		// connectionGater: {
		// 	denyDialMultiaddr: async () => false,
		// 	denyInbound: async (maConn) => {
		// 		try {
		// 			const peerId = maConn.remotePeer
		// 			const peer = await libp2p.peerStore.get(peerId)
					
		// 			// Check if peer is discovered through pubsub peer discovery
		// 			const topics = peer?.tags?.map(tag => tag.name) || []
					
		// 			// Allow inbound connections only from peers in the Doichain discovery topic
		// 			if (topics.includes('doichain._peer-discovery._p2p._pubsub')) {
		// 				return false // allow connection
		// 			}
					
		// 			// Deny inbound connections from peers only in the general discovery topic
		// 			if (topics.includes('_peer-discovery._p2p._pubsub')) {
		// 				return true // deny connection
		// 			}
					
		// 			return true // deny by default
		// 		} catch (error) {
		// 			logger.error('Error in connection gater:', error)
		// 			return true // deny on error
		// 		}
		// 	},
		// 	denyOutbound: async (peerId) => {
		// 		try {
		// 			const peer = await libp2p.peerStore.get(peerId)
		// 			const topics = peer?.tags?.map(tag => tag.name) || []
					
		// 			// Allow outbound connections to peers in either discovery topic
		// 			if (topics.includes('doichain._peer-discovery._p2p._pubsub') ||
		// 				topics.includes('_peer-discovery._p2p._pubsub')) {
		// 				return false // allow connection
		// 			}
					
		// 			return true // deny by default
		// 		} catch (error) {
		// 			logger.error('Error in connection gater:', error)
		// 			return true // deny on error
		// 		}
		// 	}
		// },
		connectionEncrypters: [noise()],
		streamMuxers: [yamux(),tls()],
		peerDiscovery: [
			pubsubPeerDiscovery({
				interval: 10000,
				topics: pubsubPeerDiscoveryTopics,
				listenOnly: false
			})
		],
		services: {
			ping: ping(),
			identify: identify(),
			uPnPNAT: uPnPNAT(),
			autoNAT: autoNAT(),
			dht: kadDHT(),
			dcutr: dcutr(),
			pubsub: gossipsub({ doPX: true, allowPublishToZeroTopicPeers: true, canRelayMessage: true, scoreThresholds}),
			relay: circuitRelayServer({
				reservations: {
					maxReservations: Infinity
				},
				advertise: {
					bootDelay: 15 * 60 * 1000 // how long to wait after startup before re-advertising
				}
			})
		}
	})

	console.log('Libp2p peerId:', libp2p.peerId.toString())

	const helia = await createHelia({
		libp2p,
		datastore,
		blockstore,
	})

	console.log('Helia peerId:', helia.libp2p.peerId.toString())
	console.log('Configured listen addresses:', listenAddresses)
	console.log('Actual listen addresses:', helia.libp2p.getMultiaddrs().map(ma => ma.toString()))

	return { helia }
}

const { helia } = await createNode()
logger.info('Helia is running')
//when a peer connecs we need to update the peer list
helia.libp2p.addEventListener('peer:connect', async event => {
	// console.log('peer:connect', event.detail)
	await retryFailedCIDs(helia)
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
            const cid  = message.substring(8)
            const addingMsg = "ADDING-CID:"+cid
            console.log("publishing query in ipfs:", addingMsg)
            helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(addingMsg))
            console.log("querying published")

            for await (const buf of fsHelia.cat(cid)) { console. info(buf) }
            const addedMsg = "ADDED-CID:"+cid
            console.log("publishing", addedMsg)
            helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(addedMsg))

            const pinCid = CID.parse(cid)
            console.log('publishing pinning ', pinCid)
            helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNING-CID:"+cid))
            const pin = await helia.pins.add(pinCid, {
                onProgress: (evt) => console.log('pin event', evt)
            });
            console.log("pinning done - publishing pinning",pinCid)
            helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNED-CID:"+cid))
            console.log("pinning published")

        } else if (message.startsWith("LIST_")) {
            console.log("Received LIST request:");
            const dateString = message.substring(5); // Extract the date part
            
            if (dateString === "LAST_100") {
                console.log("Fetching last 100 name_ops");
                const lastNameOps = await getLastNameOps(helia, 100);
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

// Add this after creating the libp2p node
helia.libp2p.services.pubsub.addEventListener('gossipsub:message', (evt) => {
	const { from, topic, data } = evt.detail
	logger.info(`Outgoing pubsub message to ${from} on topic ${topic}`, { message: new TextDecoder().decode(data) })
})


async function retryFailedCIDsWithAttempts(helia, maxAttempts = 3, timeWindow = 5000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await retryFailedCIDs(helia);
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

await retryFailedCIDsWithAttempts(helia);


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
  logger.info('Starting blockchain scanning...')
  scanBlockchainForNameOps(electrumClient, helia)
} else {
  logger.info('Blockchain scanning is disabled')
}

createHttpServer(helia)

