import dotenv from 'dotenv';
import { tcp } from '@libp2p/tcp'
import { bootstrap } from '@libp2p/bootstrap'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { ping } from "@libp2p/ping"
import { autoNAT } from "@libp2p/autonat"
import { dcutr } from "@libp2p/dcutr"
import { webRTCDirect, webRTC } from "@libp2p/webrtc"
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery"
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { multiaddr } from '@multiformats/multiaddr'
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { kadDHT } from '@libp2p/kad-dht'
import { uPnPNAT } from '@libp2p/upnp-nat'
import { prometheusMetrics } from '@libp2p/prometheus-metrics'
import { mdns } from '@libp2p/mdns'

import logger from './logger.js'
dotenv.config();

const bootstrapList = process.env.RELAY_BOOTSTRAP_LIST ? process.env.RELAY_BOOTSTRAP_LIST.split(',') : [];
const enableUPnP = process.env.ENABLE_UPNP === 'true'

export function createLibp2pConfig({ keyPair, datastore, listenAddresses, announceAddresses, pubsubPeerDiscoveryTopics, scoreThresholds }) {
    return {
        metrics: prometheusMetrics(),
        privateKey: keyPair,
        datastore,
        addresses: {
            listen: listenAddresses,
            announce: announceAddresses
        },
        connectionManager: {
            maxConnections: 1000,
            minConnections: 10,
            maxIncomingPendingConnections: 100,
            maxOutgoingPendingConnections: 100,
            pollInterval: 2000,
            maxDialTimeout: 30000,
            inboundUpgradeTimeout: 30000,
        },
        transports: [
            tcp(),
            webRTCDirect(),
            webRTC(),
            // webRTCDirect({
            //     rtcConfiguration: {
            //         iceServers: [
            //             { urls: ['stun:stun.l.google.com:19302'] },
            //             { urls: ['stun:global.stun.twilio.com:3478'] }
            //         ]
            //     }
            // }),
            // webRTC({
            //     rtcConfiguration: {
            //         iceServers: [
            //             { urls: ['stun:stun.l.google.com:19302'] },
            //             { urls: ['stun:global.stun.twilio.com:3478'] }
            //         ]
            //     },
            // }),
            circuitRelayTransport({ discoverRelays: 1 }),
            webSockets({
                filter: filters.all,
                listener: (socket) => {
                    const remoteAddr = multiaddr(socket.remoteAddress).toString()
                    logger.info(`WebSocket connection established with: ${remoteAddr}`)
                }
            })
        ],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        peerDiscovery: [
            bootstrap({ list: bootstrapList }),
            pubsubPeerDiscovery({
                interval: 10000,
                topics: pubsubPeerDiscoveryTopics,
                listenOnly: false
            }),
            mdns()
        ],
        services: {
            ping: ping(),
            identify: identify(),
            autoNAT: autoNAT(),
            dht: kadDHT(),
            dcutr: dcutr(),
            pubsub: gossipsub({ 
                allowPublishToZeroTopicPeers: true, 
                canRelayMessage: true, 
                scoreThresholds
            }),
            circuitRelay: circuitRelayServer(),
            // circuitRelay: circuitRelayServer({
            //     reservations: {
            //         maxReservations: 1000
            //     },
            //     advertise: {
            //         bootDelay: 15 * 60 * 1000
            //     }
            // }),
            ...(enableUPnP ? { uPnPNAT: uPnPNAT() } : {})
        },
        connectionGater: {
            denyDialMultiaddr: async () => false,
        }
    }
}                