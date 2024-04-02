import { createLibp2p } from 'libp2p'
import { identify } from '@libp2p/identify'
import { yamux } from '@chainsafe/libp2p-yamux'
import { noise } from '@chainsafe/libp2p-noise'
import { circuitRelayTransport,circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { createFromPrivKey } from '@libp2p/peer-id-factory'
import { unmarshalPrivateKey } from '@libp2p/crypto/keys'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { bootstrap } from "@libp2p/bootstrap";
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery";
import { ping } from "@libp2p/ping";
import { autoNAT } from "@libp2p/autonat";
import { dcutr } from "@libp2p/dcutr";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import 'dotenv/config'

export const CONTENT_TOPIC = "/dContact/3/message/proto";
const relayPrivKey = process.env.RELAY_PRIVATE_KEY;
const bootstrapList = process.env.RELAY_BOOTSTRAP_LIST.split(',')
const listenAddresses = process.env.RELAY_LISTEN_ADDRESSES.split(',')
const announceAddresses = process.env.RELAY_ANNOUNCE_ADDRESSES.split(',')
const pubsubPeerDiscoveryTopics = process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS.split(',')
const relayDevMode = process.env.RELAY_DEV_MODE

console.log("RELAY_PUBSUB_PEER_DISCOVERY_TOPICS",pubsubPeerDiscoveryTopics)
// the peer id of the above key
// const relayId = '12D3KooWAJjbRkp8FPF5MKgMU53aUTxWkqvDrs4zc1VMbwRwfsbE'

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
		// circuitRelayTransport({discoverRelays:2}),
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
		bootstrap({
			list: bootstrapList
		}),
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
		// autoNAT: autoNAT(),
		dcutr: dcutr(),
		pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, canRelayMessage: true, scoreThresholds}),
		relay: circuitRelayServer({
			reservations: {
				maxReservations: Infinity
			}
		})
	}
}
const server = await createLibp2p(config)
server.addEventListener('peer:connect', async event => {
	console.log('peer:connect', event.detail)
})

server.addEventListener('peer:disconnect', async event => {
	console.log('peer:disconnect', event.detail)
	server.peerStore.delete(event.detail)
})
server.services.pubsub.subscribe(CONTENT_TOPIC)
server.services.pubsub.addEventListener('message', event => {
	const topic = event.detail.topic
	const message = toString(event.detail.data)
	if(!topic.startsWith(CONTENT_TOPIC)) return
	console.log(`Message received on topic '${topic}': ${message}`)
	server.services.pubsub.publish(event.detail.data)
})

console.log(server.peerId.toString())
console.log('p2p addr: ', server.getMultiaddrs().map((ma) => ma.toString()))
// generates a deterministic address: /ip4/127.0.0.1/tcp/33519/ws/p2p/12D3KooWAJjbRkp8FPF5MKgMU53aUTxWkqvDrs4zc1VMbwRwfsbE
