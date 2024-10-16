import 'dotenv/config'

// External libraries
import moment from 'moment'
import { CID } from "multiformats/cid"
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'

// Libp2p and related modules
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery"
import { bootstrap } from "@libp2p/bootstrap"
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys'

// Helia and related modules
import { createHelia, libp2pDefaults } from 'helia'
import { unixfs } from "@helia/unixfs"

// Storage modules
import { LevelBlockstore } from "blockstore-level"
import { LevelDatastore } from "datastore-level"

// Local modules
import logger from './logger.js'
import { connectElectrum } from "./doichain/connectElectrum.js"
import { getNameOpsCidsForDate } from "./pinner/scanBlockchainForNameOps.js"
import { scanBlockchainForNameOps } from '../src/pinner/scanBlockchainForNameOps.js'

export const CONTENT_TOPIC = process.env.CONTENT_TOPIC || "/doichain-nfc/1/message/proto"

const privKeyHex = process.env.RELAY_PRIVATE_KEY
const bootstrapList = process.env.RELAY_BOOTSTRAP_LIST?.split(',')||[]
const listenAddresses = process.env.RELAY_LISTEN_ADDRESSES?.split(',') || ['/ip4/0.0.0.0/tcp/9090']
const announceAddresses = process.env.RELAY_ANNOUNCE_ADDRESSES?.split(',')
const pubsubPeerDiscoveryTopics = process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS?.split(',')||['dev-doichain._peer-discovery._p2p._pubsub']
const relayDevMode = process.env.RELAY_DEV_MODE

let blockstore = new LevelBlockstore("./helia-blocks")
let datastore = new LevelDatastore("./helia-data")

const privKeyBuffer = uint8ArrayFromString(privKeyHex, 'hex')
const keyPair = privateKeyFromProtobuf(privKeyBuffer)

let scoreThresholds = {}
if(relayDevMode) scoreThresholds = {
	gossipThreshold: -Infinity,
	publishThreshold: -Infinity,
	graylistThreshold: -Infinity,
}

const config = libp2pDefaults({
	transports: [tcp()],
})

if(bootstrapList && bootstrapList.length > 0) {
	config.peerDiscovery = [
		bootstrap({ list: bootstrapList }),
		pubsubPeerDiscovery({
			interval: 10000,
			topics: pubsubPeerDiscoveryTopics,
			listenOnly: false
		})
	]
}

async function createNode () {
	const libp2p = await createLibp2p({
		privateKey: keyPair,
		datastore,
		addresses: {
			listen: listenAddresses,
			announce: announceAddresses
		},
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		peerDiscovery: [
			pubsubPeerDiscovery({
				interval: 10000,
				topics: pubsubPeerDiscoveryTopics,
				listenOnly: false
			})
		],
		services: {
			identify: identify(),
			pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, canRelayMessage: true, scoreThresholds })
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
const network = { name: 'doichain-mainnet' }; // Replace with actual network object
const electrumClient = await connectElectrum(network, (x,y)=>{})

helia.libp2p.addEventListener('peer:connect', async event => {
/*	console.log('peer:connect', event.detail)*/
})

helia.libp2p.services.pubsub.subscribe(CONTENT_TOPIC)
helia.libp2p.services.pubsub.addEventListener('message', async event => {
		const topic = event.detail.topic
		if(!topic.startsWith(CONTENT_TOPIC)) return

		const message = new TextDecoder().decode(event.detail.data)
		logger.info("message detail", { message })
		const fs2 = unixfs(helia)
		try {
			if(message.startsWith("NEW-CID")){
				const cid  = message.substring(8)
				const addingMsg = "ADDING-CID:"+cid
				console.log("publishing query in ipfs:", addingMsg)
				helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(addingMsg))
				console.log("querying published")

				for await (const buf of fs2.cat(cid)) { console. info(buf) }
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
				console.log("Received LIST request:", message);
				const dateString = message.substring(5); // Extract the date part
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
		} catch(ex){
		console.log("exception during message handling",ex)
		}
})
scanBlockchainForNameOps(electrumClient, helia)
