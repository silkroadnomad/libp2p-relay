import 'dotenv/config'
import { createHelia, libp2pDefaults } from 'helia'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
// import { tls } from '@libp2p/tls'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { LevelBlockstore } from "blockstore-level"
import { LevelDatastore } from "datastore-level"
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery"
import { bootstrap } from "@libp2p/bootstrap"
import { scanBlockchainForNameOps } from "./pinner/scanBlockchainForNameOps.js"
import logger from './logger.js'
import { createFromJSON } from "@libp2p/peer-id-factory";
import { defaultLogger } from "@libp2p/logger";
import { ipns } from "@helia/ipns";
import { connectElectrum } from "./doichain/connectElectrum.js";
import {unixfs} from "@helia/unixfs";
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { createLibp2p } from 'libp2p'
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import {CID} from "multiformats/cid";
import { getTodayNameOpsCids } from "./pinner/scanBlockchainForNameOps.js";
import { getNameOpsCidsForDate } from "./pinner/scanBlockchainForNameOps.js";
import moment from 'moment';

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
	// acceptPXThreshold: 10,
	// opportunisticGraftThreshold: 20
}

const config = libp2pDefaults({
	transports: [tcp()],
})

if(bootstrapList && bootstrapList.length > 0) {
	config.peerDiscovery = [
		bootstrap({ list: bootstrapList }),
		pubsubPeerDiscovery({
			interval: 10000,
			topics: pubsubPeerDiscoveryTopics, // defaults to ['_peer-discovery._p2p._pubsub'] //if we enable this too many will connect to us!
			listenOnly: false
		})
	]
}

async function createNode () {
	const libp2p = await createLibp2p({
		privateKey: keyPair, // Directly use the key pair as privateKey
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

	const ipnsInstance = ipns({
		datastore,
		routing: helia.libp2p.services.pubsub,
		logger: defaultLogger(),
	})

	return { helia, ipnsInstance }
}

const { helia, ipnsInstance} = await createNode()
logger.info('Helia is running')
const network = { name: 'doichain-mainnet' }; // Replace with actual network object
const electrumClient = await connectElectrum(network, (x,y)=>{//logger.info("updateStore")

})

helia.libp2p.addEventListener('peer:connect', async event => {
/*	console.log('peer:connect', event.detail)*/
})
//
// node.libp2p.addEventListener('peer:disconnect', async event => {
// 	// console.log('peer:disconnect', event.detail)
// 	//libp2p.peerStore.delete(event.detail)
// })
//
// node.libp2p.addEventListener("peer:discovery", ev => {
// 	// console.log("[peer:discovery]", ev.detail);
// });

helia.libp2p.services.pubsub.subscribe(CONTENT_TOPIC)
// console.log("subscribers", helia.libp2p.services.pubsub.getSubscribers())
helia.libp2p.services.pubsub.addEventListener('message', async event => {
		const topic = event.detail.topic
		if(!topic.startsWith(CONTENT_TOPIC)) return

		const message = new TextDecoder().decode(event.detail.data)
		logger.info("message detail", { message })
		const fs2 = unixfs(helia)
		try {
			if(message.startsWith("NEW-CID")){
				//loading cid
				const cid  = message.substring(8)
				const addingMsg = "ADDING-CID:"+cid
				console.log("publishing query in ipfs:", addingMsg)
				helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(addingMsg))
				console.log("querying published")

				for await (const buf of fs2.cat(cid)) { console. info(buf) }
				const addedMsg = "ADDED-CID:"+cid
				console.log("publishing", addingMsg)
				helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(addedMsg))

				//pinning
				const pinCid = CID.parse(cid)
				console.log('publishing pinning ', pinCid)
				helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNING-CID:"+cid))
				const pin = await helia.pins.add(pinCid, {
					onProgress: (evt) => console.log('pin event', evt)
				});
				console.log("pinning done - publishing pinning",pinCid)
				helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode("PINNED-CID:"+cid))
				console.log("pinning published")

				// const pinnedBlocks = await helia.pins.ls()
				// console.log("pinnedBlocks",pinnedBlocks)
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
					const cids = await getNameOpsCidsForDate(helia, ipnsInstance, date);
					const formattedDate = date.toISOString().split('T')[0]; // Format as YYYY-MM-DD
					if (cids.length > 0) {
						const response = `${formattedDate}_CIDS:` + cids.join(',');
						console.log(`Publishing CIDs for ${formattedDate}:`, response);
						helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(response));
					} else {
						console.log(`No CIDs found for ${formattedDate}`);
						helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(`${formattedDate}_CIDS:NONE`));
					}
				}
			}
		} catch(ex){
		console.log("exception during message handling",ex)
		}
})
scanBlockchainForNameOps(electrumClient,helia,ipnsInstance)

// console.info('PeerId:', Buffer.from(server.peerId.privateKey).toString('hex'))
