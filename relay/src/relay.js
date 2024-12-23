import 'dotenv/config'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
// External libraries
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { unixfs } from "@helia/unixfs"

// Storage modules
import { LevelBlockstore } from "blockstore-level"
import { LevelDatastore } from "datastore-level"

// Local modules
import logger from './logger.js'
import { connectElectrum } from "./doichain/connectElectrum.js"
import { scanBlockchainForNameOps } from '../src/pinner/scanBlockchainForNameOps.js'

import fs from 'fs/promises'

import { createHttpServer } from './httpServer.js'
import TipWatcher from './pinner/tipWatcher.js'
import { DoichainRPC } from './doichainRPC.js';
import { createNode } from './nodeFactory.js';
import { setupPubsub } from './pubsubHandler.js';

export const CONTENT_TOPIC = process.env.CONTENT_TOPIC || "/doichain-nfc/1/message/proto"

const privKeyHex = process.env.RELAY_PRIVATE_KEY
const bootstrapList = process.env.RELAY_BOOTSTRAP_LIST?.split(',')||[]
const listenAddresses = process.env.RELAY_LISTEN_ADDRESSES?.split(',') || ['/ip4/0.0.0.0/tcp/9090', '/ip4/0.0.0.0/tcp/9091']
const announceAddresses = process.env.RELAY_ANNOUNCE_ADDRESSES?.split(',') || ['/ip4/127.0.0.1/tcp/9090', '/ip4/127.0.0.1/tcp/9091']
const pubsubPeerDiscoveryTopics = process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS?.split(',')||['doichain._peer-discovery._p2p._pubsub']
const relayDevMode = process.env.RELAY_DEV_MODE
const relayLocalRegTest = process.env.RELAY_LOCAL_REGTTEST

let blockstore = new LevelBlockstore("./helia-blocks")
let datastore = new LevelDatastore("./helia-data")

let scoreThresholds = {}
if(relayDevMode) scoreThresholds = {
	gossipThreshold: -Infinity,
	publishThreshold: -Infinity,
	graylistThreshold: -Infinity,
}

const network = (relayLocalRegTest===undefined || (relayLocalRegTest!==true && relayLocalRegTest!=="true"))?{ name: 'doichain-mainnet' }:{ name: 'doichain-regtest' };
console.log("starting with network:", network)
const electrumClient = await connectElectrum(network, (x,y)=>{})

const doichainRPC = new DoichainRPC({
    username: process.env.DOICHAIN_RPC_USER,
    password: process.env.DOICHAIN_RPC_PASSWORD,
    port: process.env.DOICHAIN_RPC_PORT || 8339
});



// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('disable-scanning', {
    alias: 'd',
    type: 'boolean',
    description: 'Disable blockchain scanning'
  })
  .option('generate-keypair', {
    alias: 'g',
    type: 'boolean',
    description: 'Generate a new Ed25519 keypair'
  })
  .help()
  .alias('help', 'h')
  .argv

if (argv['generate-keypair']) {
  try {
    const newKeyPair = await generateKeyPair('Ed25519')
    const protobufKey = privateKeyToProtobuf(newKeyPair)
    const privateKeyHex = uint8ArrayToString(protobufKey, 'hex')
    
    console.log('New private key generated. Add this to your .env file:')
    console.log(`RELAY_PRIVATE_KEY=${privateKeyHex}`)
    
    // Optionally, write to a file
    await fs.writeFile('./.env.privateKey', `RELAY_PRIVATE_KEY=${privateKeyHex}`, 'utf8')
    console.log('Private key has been saved to .env.privateKey')
    
    // Verify the key can be correctly parsed back
    const parsedKey = privateKeyFromProtobuf(uint8ArrayFromString(privateKeyHex, 'hex'))
    console.log('Verified: Key can be correctly parsed back from hex format')
    
    process.exit(0) // Exit after generating the keypair
  } catch (error) {
    console.error('Error generating keypair:', error)
    process.exit(1)
  }
}

const { helia, orbitdb, pinningService } = await createNode(
    privKeyHex,
    datastore,
    blockstore,
    listenAddresses,
    announceAddresses,
    pubsubPeerDiscoveryTopics,
    scoreThresholds,
    network
);
logger.info('Helia and OrbitDB are running')
//when a peer connecs we need to update the peer list
const fsHelia = unixfs(helia)

setupPubsub(helia, orbitdb, pinningService, electrumClient, fsHelia, CONTENT_TOPIC);

// Near the end of the file, replace the scanBlockchainForNameOps call with:
if (!argv['disable-scanning']) {
    logger.info('Starting blockchain scanning...');
    // const mempoolTxs = await doichainRPC.getRawMempool();
    // logger.info(`Current mempool has ${mempoolTxs.length} transactions`);

    await scanBlockchainForNameOps(electrumClient, helia, orbitdb); 
    const tipWatcher = new TipWatcher(electrumClient);
    tipWatcher.on('newTip', async (tip) => {
        try {
            console.log("newTip: ", tip);
            // First scan for new name operations
            await scanBlockchainForNameOps(electrumClient, helia, orbitdb, tip);
            
            // Then check for expired pins
            const pinnedCids = []
            for await (const pin of helia.pins.ls()) {
                pinnedCids.push(pin.cid.toString())
            }

            for (const cid of pinnedCids) {
                const shouldRemain = await pinningService.shouldRemainPinned(cid)
                if (!shouldRemain) {
                    logger.info(`Unpinning expired content: ${cid}`)
                    await helia.pins.rm(CID.parse(cid))
                }
            }
        } catch (error) {
            logger.error('Error processing new tip:', error);
        }
    });
    
    // Add error handler for tipWatcher
    tipWatcher.on('error', async (error) => {
        logger.error('TipWatcher error:', error);
        if (electrumClient.getStatus() !== 1) {
            try {
                await electrumClient.connect();
                logger.info('Reconnected to ElectrumX after TipWatcher error');
            } catch (reconnectError) {
                logger.error('Failed to reconnect after TipWatcher error:', reconnectError);
            }
        }
    });
    
    await tipWatcher.start();
    logger.info('TipWatcher started');
} else {
    logger.info('Blockchain scanning is disabled')
}

async function cleanup() {
    logger.info('Shutting down...')
    try {
        // await closeDB() // Close nameops DB first
        if (orbitdb) {
            await orbitdb.stop() // Then stop OrbitDB
        }
        await blockstore.close()
        await datastore.close()
        logger.info('Databases closed')
    } catch (error) {
        logger.error('Error during shutdown:', error)
    }
}

process.on('SIGINT', async () => {
    await cleanup()
    process.exit(0)
})

process.on('SIGTERM', async () => {
    await cleanup()
    process.exit(0)
})

// Initialize HTTP server with retries
let httpServerStarted = false;
const maxHttpRetries = 5;
let httpAttempt = 0;

while (!httpServerStarted && httpAttempt < maxHttpRetries) {
    try {
        await createHttpServer(helia, orbitdb, electrumClient);
        httpServerStarted = true;
        logger.info('HTTP server started successfully', {
            attempt: httpAttempt + 1
        });
    } catch (error) {
        httpAttempt++;
        logger.warn(`Failed to start HTTP server (attempt ${httpAttempt}/${maxHttpRetries})`, { error });
        if (httpAttempt === maxHttpRetries) {
            throw new Error(`Failed to start HTTP server after ${maxHttpRetries} attempts`);
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

