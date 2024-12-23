import { expect } from 'chai';
import { createHelia, libp2pDefaults } from 'helia';
import { unixfs } from '@helia/unixfs';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import moment from 'moment';
import { identify } from '@libp2p/identify';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery"
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { bootstrap } from "@libp2p/bootstrap"
import { multiaddr } from '@multiformats/multiaddr'
import { mdns } from '@libp2p/mdns'
import { getOrCreateDB } from '../src/pinner/nameOpsFileManager.js'

const pubsubPeerDiscoveryTopics = process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS?.split(',')
const CONTENT_TOPIC = '/doichain-nfc/1/message/proto';

describe('Doichain Relay Pinning Service Test', function() {
  this.timeout(100000); 

  let helia, fs, pubsub;
  const messages = [];
  const TIMEOUT = 5000;

  // Helper function to check if OrbitDB has nameOps
  async function waitForNameOps(orbitdb, maxAttempts = 20) {
    console.log('[waitForNameOps] Starting check for nameOps...');
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        console.log(`[waitForNameOps] Attempt ${attempt + 1}/${maxAttempts}`);
        
        const db = await getOrCreateDB(orbitdb);
        if (!db) {
          console.error('[waitForNameOps] Failed to get OrbitDB instance');
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
        
        const allDocs = await db.all();
        console.log(`[waitForNameOps] Found ${allDocs.length} documents in OrbitDB`);
        
        if (allDocs.length > 0) {
          console.log('[waitForNameOps] Successfully found nameOps');
          return true;
        }
        
        console.log('[waitForNameOps] No nameOps found yet, waiting 3 seconds...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (error) {
        console.error(`[waitForNameOps] Error in attempt ${attempt + 1}:`, error);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    
    console.error('[waitForNameOps] Failed to find nameOps after all attempts');
    return false;
  }

  before(async function() {
    this.timeout(300000); // Increase timeout for initialization
    
    try {
      console.log('[Setup] Starting test node setup...');
      
      // Initialize OrbitDB first
      const { createOrbitDB } = await import('@orbitdb/core');
      global.orbitdb = await createOrbitDB({ directory: './orbitdb-test' });
      console.log('[Setup] OrbitDB initialized:', global.orbitdb.id);
      
      helia = await createHelia({
      libp2p: {
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
            bootstrap({ list: ['/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWQpeSaj6FR8SpnDzkESTXY5VqnZVWNUKrkqymGiZTZbW2'] }),
            pubsubPeerDiscovery({
                interval: 10000,
                topics: pubsubPeerDiscoveryTopics,
                listenOnly: false
            }),
            mdns()
        ]
      }
    });

  console.log('Peer ID:', helia.libp2p.peerId.toString());

    fs = unixfs(helia);
    pubsub = helia.libp2p.services.pubsub;

    await pubsub.subscribe(CONTENT_TOPIC);
    console.log('Subscribed to topic:', CONTENT_TOPIC);

    pubsub.addEventListener('message', (event) => {
      if (event.detail.topic === CONTENT_TOPIC) {
        const message = new TextDecoder().decode(event.detail.data);
        console.log("Received message:", message);
        messages.push(message);
      }
    });

    await new Promise(resolve => setTimeout(resolve, TIMEOUT));

      // Wait for nameOps to be indexed
      console.log('[Setup] Waiting for nameOps to be indexed in OrbitDB...');
      const hasNameOps = await waitForNameOps(global.orbitdb);
      if (!hasNameOps) {
        console.warn('[Setup] No nameOps found in OrbitDB after timeout');
      }
    } catch (error) {
      console.error('[Setup] Error in test setup:', error);
      throw error;
    }
  });

  after(async () => {
    try {
      console.log('[Cleanup] Starting cleanup...');
      if (global.orbitdb) {
        const { closeDB } = await import('../src/pinner/nameOpsFileManager.js');
        await closeDB();
        delete global.orbitdb;
        console.log('[Cleanup] OrbitDB closed and cleaned up');
      }
      if (helia) {
        await helia.stop();
        console.log('[Cleanup] Helia node stopped');
      }
    } catch (error) {
      console.error('[Cleanup] Error during cleanup:', error);
      throw error;
    }
  });

  it('should connect to the existing Helia node and check for specific peer', async function() {
    const peers = await helia.libp2p.getPeers();
    const targetPeerId = '12D3KooWQpeSaj6FR8SpnDzkESTXY5VqnZVWNUKrkqymGiZTZbW2';
    
    const targetConnection = peers.find(peer => peer.toString() === targetPeerId);
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

  it.only('should receive CIDs response when requesting LIST_TODAY', async function() {
    this.timeout(60000); // Increase timeout
    messages.length = 0;
    
    try {
      // Wait for nameOps to be indexed before starting test
      console.log('[LIST_TODAY] Waiting for nameOps...');
      const hasNameOps = await waitForNameOps(global.orbitdb);
      expect(hasNameOps, 'Expected nameOps to be indexed before running test').to.be.true;

    // Use "TODAY" for consistent date handling
    const messageObject = {
        type: "LIST",
        dateString: "TODAY", // Use TODAY instead of hardcoded date
        pageSize: 10,
        from: 0,
        filter: ""
    };

    console.log('[LIST_TODAY] Publishing LIST request message');
    await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(JSON.stringify(messageObject)));

    // Wait longer for response
    console.log('[LIST_TODAY] Waiting for response...');
    await new Promise(resolve => setTimeout(resolve, 30000));

    const nameOps = messages.flatMap(msg => {
      try {
        const parsed = JSON.parse(msg);
        console.log('[LIST_TODAY] Parsed message:', parsed);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        console.error('[LIST_TODAY] Error parsing message:', e);
        return [];
      }
    });

    console.log(`[LIST_TODAY] Received ${nameOps.length} nameOps`);
    expect(nameOps.length).to.be.greaterThan(0);
    nameOps.forEach(op => {
      expect(op).to.have.property('nameId');
      expect(op).to.have.property('txid');
    });
    } catch (error) {
      console.error('[LIST_TODAY] Error in test:', error);
      throw error;
    }
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

  it.only('should receive last 100 NameOps when requesting LIST_LAST_100', async function() {
    this.timeout(60000); // Increase timeout
    messages.length = 0;
    
    try {
      // Wait for nameOps to be indexed before starting test
      console.log('[LIST_LAST_100] Waiting for nameOps...');
      const hasNameOps = await waitForNameOps(global.orbitdb);
      expect(hasNameOps, 'Expected nameOps to be indexed before running test').to.be.true;

    const messageObject = {
        type: "LIST",
        dateString: "LAST", // Add dateString parameter to avoid INVALID_DATE_FORMAT
        pageSize: 100,
        from: 0,
        filter: ""  // empty string for no filter
    };

    console.log('[LIST_LAST_100] Publishing LIST request message');
    await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(JSON.stringify(messageObject)));

    // Wait for response
    console.log('[LIST_LAST_100] Waiting for response...');
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Process the response
    const nameOps = messages.flatMap(msg => {
      try {
        const parsed = JSON.parse(msg);
        console.log('[LIST_LAST_100] Parsed message:', parsed);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        console.error('[LIST_LAST_100] Error parsing message:', e);
        return [];
      }
    });

    if (nameOps.length > 0) {
      console.log(`[LIST_LAST_100] Received ${nameOps.length} NameOps`);
      expect(nameOps.length).to.be.at.most(100);
      expect(nameOps[0]).to.have.property('nameId');
      expect(nameOps[0]).to.have.property('txid');
      
      console.log("[LIST_LAST_100] First few nameIds:", nameOps.slice(0, 5).map(op => op.nameId).join(', '));
    } else {
      console.log('[LIST_LAST_100] No NameOps received');
      expect(messages).to.include('LAST_100_CIDS:NONE');
    }
    } catch (error) {
      console.error('[LIST_LAST_100] Error in test:', error);
      throw error;
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
