import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tls } from '@libp2p/tls'
import { identify } from '@libp2p/identify'
import { ping } from "@libp2p/ping"
import { autoNAT } from "@libp2p/autonat"
import { dcutr } from "@libp2p/dcutr"
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery"
import { webSockets } from '@libp2p/websockets'
import { webRTCDirect, webRTC } from '@libp2p/webrtc'
import * as filters from '@libp2p/websockets/filters'
import { multiaddr } from '@multiformats/multiaddr'
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { kadDHT } from '@libp2p/kad-dht'
import { uPnPNAT } from '@libp2p/upnp-nat'
import logger from './logger.js'

export function createLibp2pConfig({ keyPair, datastore, listenAddresses, announceAddresses, pubsubPeerDiscoveryTopics, scoreThresholds }) {
    return {
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
            webRTCDirect({
                rtcConfiguration: {
                    iceServers: [
                        { urls: ['stun:stun.l.google.com:19302'] },
                        { urls: ['stun:global.stun.twilio.com:3478'] }
                    ],
                    iceTransportPolicy: 'all',
                    rtcpMuxPolicy: 'require'
                },
                maxStreamWindowSize: 512 * 1024
            }),
            webRTC({
                rtcConfiguration: {
                    iceServers: [
                        { urls: ['stun:stun.l.google.com:19302'] },
                        { urls: ['stun:global.stun.twilio.com:3478'] }
                    ],
                    iceTransportPolicy: 'all',
                    rtcpMuxPolicy: 'require'
                },
                maxStreamWindowSize: 512 * 1024
            }),
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
        streamMuxers: [yamux(), tls()],
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
            pubsub: gossipsub({ 
                doPX: true, 
                allowPublishToZeroTopicPeers: true, 
                canRelayMessage: true, 
                scoreThresholds
            }),
            relay: circuitRelayServer({
                reservations: {
                    maxReservations: Infinity
                },
                advertise: {
                    bootDelay: 15 * 60 * 1000
                }
            })
        },
        connectionGater: {
            denyDialMultiaddr: async () => false,
        }
    }
} 