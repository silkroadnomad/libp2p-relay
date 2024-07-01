import 'dotenv/config'
import { createLibp2p } from 'libp2p'
import { createHelia } from 'helia'
import { identify } from '@libp2p/identify'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { circuitRelayServer,circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { createFromPrivKey } from '@libp2p/peer-id-factory'
import { unmarshalPrivateKey } from '@libp2p/crypto/keys'
import { toString } from 'uint8arrays/to-string'
import { bootstrap } from "@libp2p/bootstrap";
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery";
import { ping } from "@libp2p/ping";
import { autoNAT } from "@libp2p/autonat";
import { dcutr } from "@libp2p/dcutr";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { LevelBlockstore } from "blockstore-level"
import { LevelDatastore } from "datastore-level";
import * as filters from "@libp2p/websockets/filters";
export const CONTENT_TOPIC = process.env.CONTENT_TOPIC || "/dContact/3/message/proto";

//output of: console.log(server.peerId.privateKey.toString('hex'))
//hex of libp2p  console.info('PeerId:', Buffer.from(server.peerId.privateKey).toString('hex'))
const relayPrivKey = process.env.RELAY_PRIVATE_KEY;
const bootstrapList = process.env.RELAY_BOOTSTRAP_LIST?.split(',')
const listenAddresses = process.env.RELAY_LISTEN_ADDRESSES?.split(',')
const announceAddresses = process.env.RELAY_ANNOUNCE_ADDRESSES?.split(',')
const pubsubPeerDiscoveryTopics = process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS?.split(',')
const relayDevMode = process.env.RELAY_DEV_MODE

console.log("RELAY_PUBSUB_PEER_DISCOVERY_TOPICS",pubsubPeerDiscoveryTopics)

const encoded = uint8ArrayFromString(relayPrivKey, 'hex')
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

const config = {
	peerId,
	addresses: {
		listen: listenAddresses,
		announce: announceAddresses
	},
	transports: [
		circuitRelayTransport({ discoverRelays:2 }),
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
	peerDiscovery: [
		pubsubPeerDiscovery({
			interval: 10000,
			topics: pubsubPeerDiscoveryTopics, // defaults to ['_peer-discovery._p2p._pubsub']
			listenOnly: false
		})
	],
	services: {
		ping: ping({
			protocolPrefix: 'dContact', // default
		}),
		identify: identify(),
		autoNAT: autoNAT(),
		dcutr: dcutr(),
		pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, canRelayMessage: true, scoreThresholds}),
		relay: circuitRelayServer({
			reservations: {
				maxReservations: Infinity
			}
		})
	}
}

if(bootstrapList && bootstrapList.length > 0)
	config.peerDiscovery = bootstrap({ list: bootstrapList })

async function createNode () {
	const libp2p = await createLibp2p(config)
	libp2p.addEventListener('self:peer:update', (evt) => {
		// Updated self multiaddrs?
		console.log('Advertising with a relay address of ', libp2p.getMultiaddrs().map((ma) => ma.toString()))
		// console.log(`Advertising with a relay address of ${libp2p.getMultiaddrs()[0].toString()}`)
	})
	libp2p.addEventListener('peer:connect', async event => {
		console.log('peer:connect', event.detail)
	})

	libp2p.addEventListener('peer:disconnect', async event => {
		console.log('peer:disconnect', event.detail)
		libp2p.peerStore.delete(event.detail)
	})
	// libp2p.services.pubsub.subscribe("doichain-nfc")
	libp2p.services.pubsub.subscribe(CONTENT_TOPIC)
	libp2p.services.pubsub.addEventListener('message', event => {

		// const message = toString(event.detail.data)
		const topic = event.detail.topic
		console.log("message topic",topic)
		console.log("message detail",toString(event.detail.data))

		// if(!topic.startsWith(CONTENT_TOPIC)) return
		// console.log(`Message received on topic '${topic}': ${message}`)
		// libp2p.services.pubsub.publish(event.detail.data)
	})

	let blockstore = new LevelBlockstore("./helia-blocks")
	let datastore = new LevelDatastore("./helia-data")
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
// console.info('PeerId:', Buffer.from(server.peerId.privateKey).toString('hex'))
// generates a deterministic address: /ip4/127.0.0.1/tcp/33519/ws/p2p/12D3KooWAJjbRkp8FPF5MKgMU53aUTxWkqvDrs4zc1VMbwRwfsbE
