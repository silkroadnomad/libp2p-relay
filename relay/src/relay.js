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
		connectionGater: {
			denyDialMultiaddr: async () => false
		},
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
	console.log('peer:connect', event.detail)
	await retryFailedCIDs(helia)
	helia.libp2p.getPeers().forEach(peer => {
		console.log('Peer connected:', peer.toString())
	})
})
const fsHelia = unixfs(helia)

helia.libp2p.services.pubsub.subscribe(CONTENT_TOPIC)

// Define a simple codec for the Peer structure
const peerCodec = {
  encode: () => {
    throw new Error('Encoding not implemented')
  },
  decode: (reader) => {
    const obj = {
      publicKey: new Uint8Array(0),
      addrs: []
    }

    while (reader.pos < reader.len) {
      const tag = reader.uint32()

      switch (tag >>> 3) {
        case 1:
          obj.publicKey = reader.bytes()
          break
        case 2:
          obj.addrs.push(reader.bytes())
          break
        default:
          reader.skipType(tag & 7)
          break
      }
    }

    return obj
  }
}

helia.libp2p.services.pubsub.addEventListener('message', async event => {
    logger.info(`Received pubsub message from ${event.detail.from} on topic ${event.detail.topic}`)
    const topic = event.detail.topic
    const from = event.detail.from

    if (topic === 'doichain._peer-discovery._p2p._pubsub') {
        try {
            const peer = decodeMessage(event.detail.data, peerCodec)
            
            // Format the public key as a hex string
            const publicKeyHex = Buffer.from(peer.publicKey).toString('hex')
            
            // Format the addresses
            const formattedAddrs = peer.addrs.map(addr => {
                try {
                    return multiaddr(addr).toString()
                } catch (err) {
                    return `<invalid multiaddr: ${Buffer.from(addr).toString('hex')}>`
                }
            })

            logger.info('Discovered peer on %s:', topic)
            logger.info('  Public Key: %s', publicKeyHex)
            logger.info('  Addresses:')
            formattedAddrs.forEach((addr, index) => {
                logger.info(`    ${index + 1}. ${addr}`)
            })

        } catch(err) {
            logger.error('Error processing peer discovery message:', err)
        }
    } else if (topic.startsWith(CONTENT_TOPIC)) {
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


async function getNameOpCount() {
    const nameOpDir = './data/nameops_cids' 
    try {
        const files = await fs.readdir(nameOpDir)
        return files.filter(file => file.endsWith('.json')).length
    } catch (error) {
        console.error('Error reading nameOp directory:', error)
        return 0
    }
}

function createHttpServer(helia) {
    const server = http.createServer(async (req, res) => {
        const parsedUrl = url.parse(req.url, true)
        
        if (req.method === 'GET' && parsedUrl.pathname === '/status') {
            const connectedPeers = helia.libp2p.getPeers()
            const nameOpCount = await getNameOpCount()
            
            const peerDetails = await Promise.all(connectedPeers.map(async (peerId) => {
                const connections = helia.libp2p.getConnections(peerId)
                let peer
                let peerInfo
                try {
                    peer = await helia.libp2p.peerStore.get(peerId)
                    peerInfo = await helia.libp2p.peerRouting.findPeer(peerId)
                    console.log('Peer info from routing:', peerInfo)
                } catch (error) {
                    console.error(`Error fetching info for peer ${peerId}:`, error)
                }

                return Promise.all(connections.map(async (connection) => {
                    const remotePeer = connection.remotePeer.toString()
                    const remoteAddr = connection.remoteAddr.toString()
                    const direction = connection.direction
                    const transport = connection.transient ? 'transient' : connection.multiplexer
                    const protocols = await connection.streams[0].protocol
                    return {
                        peerId: remotePeer,
                        multiaddrs: peer?.addresses?.map(addr => addr.multiaddr.toString()) || [],
                        routedMultiaddrs: peerInfo?.multiaddrs?.map(ma => ma.toString()) || [],
                        currentConnection: remoteAddr,
                        direction,
                        transport,
                        protocols
                    }
                }))
            }))

            const flatPeerDetails = peerDetails.flat()

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                connectedPeersCount: connectedPeers.length,
                nameOpCount,
                peers: flatPeerDetails
            }, null, 2))
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Not Found')
        }
    })

    const port = process.env.HTTP_PORT || 3000
    server.listen(port, () => {
        console.log(`HTTP server running on port ${port}`)
    })
}

createHttpServer(helia)  // Add this line

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

