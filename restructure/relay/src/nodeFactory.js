import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { createLibp2p } from 'libp2p';
import { createHelia } from 'helia';
import { trustlessGateway, bitswap } from '@helia/block-brokers';
import { libp2pRouting, httpGatewayRouting } from '@helia/routers';
import { createOrbitDB } from '@doichain/orbitdb';
import logger from './logger.js';
import { PinningService } from './pinner/pinningService.js';
import { connectElectrum } from "./doichain/connectElectrum.js";
import { createLibp2pConfig } from './libp2p-config.js';

export async function createNode(config) {
    // Handle both config object and individual parameters
    let privKeyHex, datastore, blockstore, listenAddresses, announceAddresses, pubsubPeerDiscoveryTopics, scoreThresholds, network;
    
    if (typeof config === 'object') {
        ({
            privKeyHex = process.env.RELAY_PRIVATE_KEY,
            datastore = config.datastore,
            blockstore = config.blockstore,
            listenAddresses = config.addresses?.listen,
            announceAddresses = config.addresses?.announce,
            pubsubPeerDiscoveryTopics = config.pubsubPeerDiscoveryTopics,
            scoreThresholds = config.scoreThresholds,
            network = 'mainnet'
        } = config);
    } else {
        [privKeyHex, datastore, blockstore, listenAddresses, announceAddresses, pubsubPeerDiscoveryTopics, scoreThresholds, network] = arguments;
    }

    // Validate privKeyHex
    if (!privKeyHex || !/^[0-9a-fA-F]+$/.test(privKeyHex)) {
        throw new Error('Invalid private key format: must be a hexadecimal string');
    }

    const privKeyBuffer = uint8ArrayFromString(privKeyHex, 'hex');
    const keyPair = await privateKeyFromProtobuf(privKeyBuffer);

    const libp2pConfig = createLibp2pConfig({
        keyPair,
        datastore,
        listenAddresses,
        announceAddresses,
        pubsubPeerDiscoveryTopics,
        scoreThresholds
    });

    const libp2p = await createLibp2p(libp2pConfig);

    console.log('Libp2p peerId:', libp2p.peerId.toString());

    const helia = await createHelia({
        libp2p,
        datastore,
        blockstore,
        blockBrokers: [
            trustlessGateway(),
            bitswap()
        ],
        routers: [
            libp2pRouting(libp2p),
            httpGatewayRouting()
        ]
    });

    // Create OrbitDB instance
    const orbitdb = await createOrbitDB({ 
        ipfs: helia,
        directory: './orbitdb', // Base directory for OrbitDB data
        id: 'doichain-relay', // Optional identifier
    });
    logger.info('OrbitDB initialized');

    console.log('Helia peerId:', helia.libp2p.peerId.toString());
    console.log('Configured listen addresses:', listenAddresses);
    console.log('Actual listen addresses:', helia.libp2p.getMultiaddrs().map(ma => ma.toString()));
    const electrumClient = await connectElectrum(network, () => {});
    const pinningService = new PinningService(helia, orbitdb, electrumClient);

    return { helia, orbitdb, pinningService };
}
