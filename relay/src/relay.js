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
import {pubsubPeerDiscovery} from "@libp2p/pubsub-peer-discovery";
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


const config = libp2pDefaults({peerId})
// if(bootstrapList && bootstrapList.length > 0){
	config.peerDiscovery = [
		// bootstrap({ list: bootstrapList }),
		pubsubPeerDiscovery({
			interval: 10000,
			topics: pubsubPeerDiscoveryTopics, // defaults to ['_peer-discovery._p2p._pubsub']
			listenOnly: false
		})
	]
// }
// console.log("config",config)


const newPubsub = {...config.services.pubsub, ...{ services: {
	pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, canRelayMessage: true,scoreThresholds }) } }}

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
		//
		// node.libp2p.addEventListener('peer:disconnect', async event => {
		// 	// console.log('peer:disconnect', event.detail)
		// 	//libp2p.peerStore.delete(event.detail)
		// })
		//
		// node.libp2p.addEventListener("peer:discovery", ev => {
		// 	// console.log("[peer:discovery]", ev.detail);
		// });

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
						const addingMsg = "ADDING-CID:"+cid
						console.log("pinning",addingMsg)
						node.libp2p.services.pubsub.publish(CONTENT_TOPIC,new TextEncoder().encode(addingMsg))
						console.log("pinning published")
						for await (const buf of fs2.cat(cid)) { console. info(buf) }
						const addedMsg = "ADDED-CID:"+cid
						console.log("pinning adding",addingMsg)
						node.libp2p.services.pubsub.publish(CONTENT_TOPIC,new TextEncoder().encode(addedMsg))
						console.log("pinning published")

						//pinning
						const pinCid = CID.parse(cid)
						console.log('pinning stored in blockstore', pinCid)
						node.libp2p.services.pubsub.publish(CONTENT_TOPIC,new TextEncoder().encode("PINNING-CID:"+cid))
						const pin = await node.pins.add(pinCid, {
							onProgress: (evt) => console.log('pin event', evt)
						});
						console.log("pinning pin",pin)
						node.libp2p.services.pubsub.publish(CONTENT_TOPIC,new TextEncoder().encode("PINNED-CID:"+cid))
						console.log("pinning published pinned")

						const pinnedBlocks = await node.pins.ls()
						console.log("pinnedBlocks",pinnedBlocks)
					}
				}catch(ex){
				console.log("exception during loading from ipfs",ex)
				}

		})
// console.info('PeerId:', Buffer.from(server.peerId.privateKey).toString('hex'))
