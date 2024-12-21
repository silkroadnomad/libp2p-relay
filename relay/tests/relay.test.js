import { expect } from 'chai';
import { createHelia, libp2pDefaults } from 'helia';
import { unixfs } from '@helia/unixfs';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import { identify } from '@libp2p/identify';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery"
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { bootstrap } from "@libp2p/bootstrap"
import { mdns } from '@libp2p/mdns'
import { DoichainRPC } from '../src/doichainRPC.js';
import net from 'net';
import dotenv from 'dotenv';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
dotenv.config();

const pubsubPeerDiscoveryTopics = process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS?.split(',')
const CONTENT_TOPIC = '/doichain-nfc/1/message/proto';

// Access the credentials and connection details from the .env file
const rpcUser = process.env.DOICHAIN_RPC_USER;
const rpcPassword = process.env.DOICHAIN_RPC_PASSWORD;
let rpcHost = 'localhost';
// const rpcHost = process.env.DOICHAIN_RPC_URL; // Assuming this includes the protocol and host
const rpcPort = process.env.DOICHAIN_RPC_PORT;
let targetPeerId
const privateKey = process.env.RELAY_PRIVATE_KEY;

describe('Doichain Relay Pinning Service Test', function() {
  this.timeout(100000); 

  let helia, fs, pubsub;
  const messages = [];
  const TIMEOUT = 5000;
  async function getPeerIdFromHexPrivateKey(privateKeyHex) {
    const privateKeyBuffer = uint8ArrayFromString(privateKeyHex, 'hex');
    try {
      const parsedKey = privateKeyFromProtobuf(privateKeyBuffer);
      let peerId = peerIdFromPrivateKey(parsedKey)
      return peerId;
    } catch (error) {
      console.error("Error creating Peer ID from private key:", error);
      throw error;
    }
  }
  
  async function waitForPeers(libp2p, expectedPeerCount, timeout = 10000) {
    const start = Date.now();
    let peers
    while (Date.now() - start < timeout) {
      peers = await libp2p.getPeers();
      if (peers.length >= expectedPeerCount) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500)); // Check every 500ms
    }
    throw new Error(`Expected at least ${expectedPeerCount} peers, but found ${peers.length}`);
  }

  before(async function() {
    this.timeout(100000);

    console.log('🔍 Checking if regtest is reachable...');
    let isRegtestReachable = await new Promise(resolve => {
      const socket = net.createConnection(18445, 'regtest', () => {
         rpcHost = 'regtest'
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });

    isRegtestReachable = await new Promise(resolve => {
      const socket = net.createConnection(18445, 'localhost', () => {
        rpcHost = 'localhost'
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (isRegtestReachable) {
      console.log('✅ Regtest is reachable!');
      console.log('📖 Using RPC credentials from .env');
      // Initialize DoichainRPC with credentials and connection details from .env
      const doichainRPC = new DoichainRPC({
        host: rpcHost,
        port: rpcPort,
        username: rpcUser,
        password: rpcPassword
      });
      console.log('🔗 Connecting to Doichain RPC...');
      const newAddress = await doichainRPC.call('getnewaddress');
      console.log(`🏠 New address generated: ${newAddress}`);
      console.log('⛏️ Mining 200 DOI...');
      await doichainRPC.call('generatetoaddress', [200, newAddress]);
      console.log('✅ Mining complete!');
    } else {
      console.log('❌ Regtest is not reachable. Skipping Doichain setup.');
    }

    console.log('🚀 Initializing Helia...');
    console.log('🔍 Generating Peer ID from private key...');
    targetPeerId = await getPeerIdFromHexPrivateKey(privateKey);
    console.log(`🆔 Relay Peer ID to connect to: ${targetPeerId.toString()}`);

    helia = await createHelia({
      libp2p: {
        // peerId: peerId,
        transports: [tcp(), webSockets()],
        connectionEncryption: [noise()],
        streamMuxers: [yamux()],
        services: {
          pubsub: gossipsub(),
          identify: identify(),
        },
        addresses: {
          listen: ['/ip4/127.0.0.1/tcp/4002', '/ip4/127.0.0.1/tcp/4003/ws']
        },
        peerDiscovery: [
            bootstrap({ list: [`/ip4/127.0.0.1/tcp/9090/p2p/${targetPeerId.toString()}`] }),
            pubsubPeerDiscovery({
                interval: 10000,
                topics: pubsubPeerDiscoveryTopics,
                listenOnly: false
            }),
            mdns()
        ]
      }
    });

    console.log(`🆔 Peer ID: ${helia.libp2p.peerId.toString()}`);

    fs = unixfs(helia);
    pubsub = helia.libp2p.services.pubsub;

    console.log(`📡 Subscribing to topic: ${CONTENT_TOPIC}`);
    await pubsub.subscribe(CONTENT_TOPIC);
    console.log('✅ Subscription complete!');

    pubsub.addEventListener('message', (event) => {
      if (event.detail.topic === CONTENT_TOPIC) {
        const message = new TextDecoder().decode(event.detail.data);
        console.log("📨 Received message:", message);
        messages.push(message);
      }
    });

    console.log('⏳ Waiting for relay peers...');
    await waitForPeers(helia.libp2p, 1); // Wait for at least 1 peer
    console.log('✅ Setup complete!');

  });

  after(async () => {
    if(helia) await helia.stop();
  });

  it('should connect to the existing Helia node and check for specific peer', async function() {
    const peers = await helia.libp2p.getPeers();
    console.log("peers",peers)
    console.log("targetPeerId",targetPeerId.toString())
    const targetConnection = peers.find(peer => peer.toString() === targetPeerId.toString());
    expect(targetConnection).to.exist;
  });

  it('should add a file to IPFS and publish messages', async () => {
    // Create valid metadata JSON
    const metadata = {
        name: "Test NFT",
        description: "Test metadata for IPFS test",
        // No image in this basic test
    };
    
    // Add metadata as JSON string
    const content = JSON.stringify(metadata);
    const cid = await fs.addBytes(uint8ArrayFromString(content));

    await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(`NEW-CID:${cid}`));

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Find and verify the ADDING-CID JSON message
    const addingMessage = messages.find(msg => {
        try {
            const parsed = JSON.parse(msg);
            return parsed.status === "ADDING-CID" && parsed.cid === cid.toString();
        } catch (e) {
            return false;
        }
    });
    expect(addingMessage).to.exist;
    
    // Parse and verify the fee structure
    const response = JSON.parse(addingMessage);
    expect(response.fee).to.exist;
    expect(response.fee.amount).to.be.a('number');
    expect(response.fee.amount).to.be.at.least(0.001, 'Fee should be at least 0.001');
    expect(response.fee.durationMonths).to.be.a('number');
    expect(response.fee.durationMonths).to.be.at.least(1);
    
    // Verify the amount has a reasonable number of decimal places
    const decimalPlaces = response.fee.amount.toString().split('.')[1]?.length || 0;
    expect(decimalPlaces).to.be.at.most(8, 'Fee should have at most 8 decimal places');
    
    // Check the plain text ADDED-CID message
    expect(messages).to.include(`ADDED-CID:${cid}`);

    // Verify the retrieved content matches our metadata
    let retrievedContent = '';
    for await (const chunk of fs.cat(cid)) {
        retrievedContent += new TextDecoder().decode(chunk);
    }
    const retrievedMetadata = JSON.parse(retrievedContent);
    expect(retrievedMetadata).to.deep.equal(metadata);
  });

  it('should receive CIDs response when requesting LIST_TODAY', async function() {
    this.timeout(20000);
    messages.length = 0;

    // Use ISO format for consistency
    const today = "2024-12-08"; 
    const messageObject = {
        type: "LIST",
        dateString: today, // Send actual date instead of "TODAY"
        pageSize: 10,
        from: 0,
        filter: ""
    };

    console.log('Publishing LIST request message');
    await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(JSON.stringify(messageObject)));
    await new Promise(resolve => setTimeout(resolve, 1000));
   const nameOps = messages.flatMap(msg => {
        try {
            const parsed = JSON.parse(msg);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    });
    //expect 3 namops
    console.log(`Received ${nameOps.length} nameOps`);
    expect(nameOps.length).to.be.greaterThan(0);
    nameOps.forEach(op => {
            expect(op).to.have.property('nameId');
            expect(op).to.have.property('txid');
        });
    
  });

  // it('should receive CIDs response for the last 5 days', async function() {
  //   this.timeout(300000);
  //   const days = 5;
  //   const startDate = moment('2024-10-05');

  //   for (let i = 0; i < days; i++) {
  //     const date = startDate.clone().subtract(i, 'days').format('YYYY-MM-DD');
  //     messages.length = 0;
      
  //     await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(`LIST_DATE:${date}`));
  //     await new Promise(resolve => setTimeout(resolve, TIMEOUT));

  //     if (messages.length === 1 && messages[0] === `${date}_CIDS:NONE`) {
  //       console.log(`No name_ops found for ${date}`);
  //       continue;
  //     }

  //     const nameOps = messages.flatMap(msg => {
  //       try {
  //         return JSON.parse(msg);
  //       } catch (e) {
  //         return [];
  //       }
  //     });

  //     expect(nameOps).to.be.an('array');
  //     expect(nameOps.length).to.be.greaterThan(0);
  //     nameOps.forEach(op => {
  //       expect(op).to.have.property('txid');
  //       expect(op).to.have.property('nameId');
  //     });
  //   }
  // });

  it('should receive last 100 NameOps when requesting LIST_LAST_100', async function() {
    this.timeout(20000); 
    messages.length = 0; 

    const messageObject = {
        type: "LIST",
        pageSize: 100,
        from: 0,
        filter: ""  // empty string for no filter
    };

    console.log('Publishing LIST request message');
    await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(JSON.stringify(messageObject)));

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Process the response
    const nameOps = messages.flatMap(msg => {
      try {
        return JSON.parse(msg);
      } catch (e) {
        return [];
      }
    });

    if (nameOps.length > 0) {
      console.log(`Received ${nameOps.length} NameOps`);
      expect(nameOps.length).to.be.at.most(100);
      expect(nameOps[0]).to.have.property('nameId');
      expect(nameOps[0]).to.have.property('txid');
      
      console.log("First few nameIds:", nameOps.slice(0, 5).map(op => op.nameId).join(', '));
    } else {
      console.log('No NameOps received');
      expect(messages).to.include('LAST_100_CIDS:NONE');
    }
  });

  it('should calculate sizes and fees for metadata with image', async () => {
    // Create sample metadata with image
    const metadata = {
      name: "Test NFT",
      description: "Test NFT with image",
      image: "" // Will be set after uploading image
    };

    // Create sample image (using a small Buffer for testing)
    const imageContent = Buffer.from('fake image content'.repeat(100)); // Create ~1.6KB fake image
    const imageCid = await fs.addBytes(imageContent);
    metadata.image = `ipfs://${imageCid}`;

    // Add metadata to IPFS
    const metadataBuffer = uint8ArrayFromString(JSON.stringify(metadata));
    const metadataCid = await fs.addBytes(metadataBuffer);

    // Clear previous messages
    messages.length = 0;

    // Trigger NEW-CID for the metadata
    await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(`NEW-CID:${metadataCid}`));

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Find the ADDING-CID response
    const addingCidResponse = messages.find(msg => {
      try {
        const parsed = JSON.parse(msg);
        return parsed.status === "ADDING-CID";
      } catch (e) {
        return false;
      }
    });

    expect(addingCidResponse).to.exist;

    const response = JSON.parse(addingCidResponse);
    expect(response).to.have.property('status', 'ADDING-CID');
    expect(response).to.have.property('cid', metadataCid.toString());
    expect(response).to.have.property('sizes');
    expect(response.sizes).to.have.property('metadata');
    expect(response.sizes).to.have.property('image');
    expect(response.sizes).to.have.property('total');
    expect(response).to.have.property('fee');
    expect(response.fee).to.have.property('amount');
    expect(response.fee).to.have.property('durationMonths');

    // Verify sizes are reasonable
    const metadataSize = parseInt(response.sizes.metadata);
    const imageSize = parseInt(response.sizes.image);
    const totalSize = parseInt(response.sizes.total);

    expect(metadataSize).to.be.above(0, 'Metadata size should be greater than 0');
    expect(imageSize).to.be.above(0, 'Image size should be greater than 0');
    expect(totalSize).to.equal(metadataSize + imageSize, 'Total size should be sum of metadata and image sizes');

    // Verify fee calculation
    expect(response.fee.amount).to.be.above(0, 'Fee should be greater than 0');
    expect(response.fee.durationMonths).to.be.at
  });
});
