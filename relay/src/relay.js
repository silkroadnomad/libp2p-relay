import 'dotenv/config'
import { createLibp2p } from 'libp2p'
import {createHelia, libp2pDefaults} from 'helia'
import { createFromPrivKey } from '@libp2p/peer-id-factory'
import { unmarshalPrivateKey } from '@libp2p/crypto/keys'
import { fromString } from 'uint8arrays/from-string'
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { LevelBlockstore } from "blockstore-level"
import { LevelDatastore } from "datastore-level";
import { unixfs } from '@helia/unixfs'
import { CID } from "multiformats";
export const CONTENT_TOPIC = process.env.CONTENT_TOPIC || "/doichain-nfc/1/message/proto";

//output of: console.log(server.peerId.privateKey.toString('hex'))
//hex of libp2p  console.info('PeerId:', Buffer.from(server.peerId.privateKey).toString('hex'))
const relayPrivKey = process.env.RELAY_PRIVATE_KEY;
const bootstrapList = process.env.RELAY_BOOTSTRAP_LIST?.split(',')
const listenAddresses = process.env.RELAY_LISTEN_ADDRESSES?.split(',')
const announceAddresses = process.env.RELAY_ANNOUNCE_ADDRESSES?.split(',')
const pubsubPeerDiscoveryTopics = process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS?.split(',')
const relayDevMode = process.env.RELAY_DEV_MODE

console.log("RELAY_PUBSUB_PEER_DISCOVERY_TOPICS",pubsubPeerDiscoveryTopics)

let blockstore = new LevelBlockstore("./helia-blocks")
let datastore = new LevelDatastore("./helia-data")

const encoded = fromString(relayPrivKey, 'hex')
const privateKey = await unmarshalPrivateKey(encoded)
const peerId = await createFromPrivKey(privateKey)

let scoreThresholds = {}
if(relayDevMode) scoreThresholds = {
	gossipThreshold: -Infinity,
	publishThreshold: -Infinity,
	graylistThreshold: -Infinity,
	// acceptPXThreshold: 10,
	// opportunisticGraftThreshold: 20
}
/*
let config = {
	peerId,
	addresses: {
		listen: listenAddresses,
		announce: announceAddresses
	},
	transports: [
		// circuitRelayTransport(),
		tcp(),
		webSockets({
			filter: filters.all
		})
	],
	connectionManager: {
		minConnections: 0
	},
	connectionEncryption: [noise()],
	streamMuxers: [yamux()],
	// peerDiscovery: [
	// 	bootstrap({
	// 		list: [
	// 			'/ip4/176.115.95.29/tcp/4001/p2p/QmXMc1k77MWG79GMSe3X4T2Em9UyPtXyPPVb1VphifUHMA',
	// 			'/ip4/65.109.31.97/tcp/4005/p2p/12D3KooWPHb3Uw2vEcDdWbd6n2EkRwT7pc4toePJyjzSRcSJqXGb',
	// 			'/ip4/168.119.172.178/tcp/4001/p2p/12D3KooWDXvBTyoFtdh3WZt18oQs9rEgBVVgoo2YPW9WFsgvbF1Z'
	// 		]
	// 	}),
	// 	pubsubPeerDiscovery({
	// 		interval: 10000,
	// 		topics: pubsubPeerDiscoveryTopics, // defaults to ['_peer-discovery._p2p._pubsub']
	// 		listenOnly: false
	// 	})
	// ],
	services: {
		ping: ping({
			protocolPrefix: 'dContact', // default
		}),
		identify: identify(),
		autoNAT: autoNAT(),
		dcutr: dcutr(),
		pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, canRelayMessage: true, scoreThresholds}),
		circuitRelay: circuitRelayServer({
				reservations: {
					maxReservations: Infinity
				}
		})
	}
}*/

// if(bootstrapList && bootstrapList.length > 0){
// 	config.peerDiscovery = [
// 		bootstrap({ list: bootstrapList }),
// 		pubsubPeerDiscovery({
// 			interval: 10000,
// 			topics: pubsubPeerDiscoveryTopics, // defaults to ['_peer-discovery._p2p._pubsub']
// 			listenOnly: false
// 		})
// 	]
// }
// console.log("config",config)
const config = libp2pDefaults({peerId})
const newPubsub = {...config.services.pubsub, ...{ services: { pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, canRelayMessage: true }) } }}
config.services.pubsub = newPubsub.services.pubsub
config.addresses = {
	listen: listenAddresses,
	announce: announceAddresses
}

async function createNode () {
	const libp2p = await createLibp2p(config)
	console.log(libp2p.peerId.toString())
	console.log('p2p addr: ', libp2p.getMultiaddrs().map((ma) => ma.toString()))
	return await createHelia({
		datastore,
		blockstore,
		libp2p
	})
}

		const node = await createNode()
		console.info('Helia is running')
		console.info('PeerId:', node.libp2p.peerId.toString())
		node.libp2p.addEventListener('peer:connect', async event => {
			// console.log('peer:connect', event.detail)
		})

		node.libp2p.addEventListener('peer:disconnect', async event => {
			// console.log('peer:disconnect', event.detail)
			//libp2p.peerStore.delete(event.detail)
		})

		node.libp2p.addEventListener("peer:discovery", ev => {
			// console.log("[peer:discovery]", ev.detail);
		});

		node.libp2p.services.pubsub.subscribe(CONTENT_TOPIC)
		console.log("subscribers", node.libp2p.services.pubsub.getSubscribers())

		node.libp2p.services.pubsub.addEventListener('message', async event => {
				const topic = event.detail.topic
				if(!topic.startsWith(CONTENT_TOPIC)) return

				const message = new TextDecoder().decode(event.detail.data)
				console.log("message detail",message)
				const fs2 = unixfs(node)
				try {
					if(message.startsWith("NEW-CID")){
						//loading cid
						const cid  = message.substring(8)
						for await (const buf of fs2.cat(cid)) {   console. info(buf) }

						//pinning
						const pinCid = CID.parse(cid)
						console.log('stored received file in blockstore', message)
						const pin = await node.pins.add(pinCid, {
							onProgress: (evt) => console.log('pin event', evt)
						});

						const pinnedBlocks = await node.pins.ls()
						console.log("pinnedBlocks",pinnedBlocks)
					}
				}catch(ex){
				console.log("exception during loading from ipfs",ex)
				}

		})
// console.info('PeerId:', Buffer.from(server.peerId.privateKey).toString('hex'))
