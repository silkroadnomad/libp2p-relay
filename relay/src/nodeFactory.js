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

export async function createNode(privKeyHex, datastore, blockstore, listenAddresses, announceAddresses, pubsubPeerDiscoveryTopics, scoreThresholds, network) {
    // Validate privKeyHex
    if (!/^[0-9a-fA-F]+$/.test(privKeyHex)) {
        throw new Error('Invalid private key format: must be a hexadecimal string', privKeyHex);
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

    // Create OrbitDB instance with retries
    let orbitdb;
    const maxRetries = 10;
    let attempt = 0;
    
    while (attempt < maxRetries) {
        try {
            orbitdb = await createOrbitDB({ 
                ipfs: helia,
                directory: './orbitdb',
                id: 'doichain-relay',
            });
            logger.info('OrbitDB initialized successfully', {
                attempt: attempt + 1,
                address: orbitdb.address,
                id: orbitdb.id
            });
            break;
        } catch (error) {
            attempt++;
            logger.warn(`Failed to initialize OrbitDB (attempt ${attempt}/${maxRetries})`, { error });
            if (attempt === maxRetries) {
                throw new Error(`Failed to initialize OrbitDB after ${maxRetries} attempts`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
        }
    }

    console.log('Helia peerId:', helia.libp2p.peerId.toString());
    console.log('Configured listen addresses:', listenAddresses);
    console.log('Actual listen addresses:', helia.libp2p.getMultiaddrs().map(ma => ma.toString()));
    const electrumClient = await connectElectrum(network, (x, y) => {});
    const pinningService = new PinningService(helia, orbitdb, electrumClient);

    return { helia, orbitdb, pinningService };
}
