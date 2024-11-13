import { expect } from 'chai';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import { MemoryBlockstore } from 'blockstore-core';
import { MemoryDatastore } from 'datastore-core';
import { identify } from '@libp2p/identify';
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { bootstrap } from "@libp2p/bootstrap"
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery"
import moment from 'moment';

const pubsubPeerDiscoveryTopics = process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS?.split(',')
const CONTENT_TOPIC = '/doichain-nfc/1/message/proto';

describe('Helia IPNS Node Test', function() {
  this.timeout(100000); 

  let helia, fs, pubsub;
  const messages = [];

  before(async function() {
    this.timeout(100000);
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
            bootstrap({ list: ['/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWR7R2mMusGhtsXofgsdY1gzVgG2ykCfS7G5NnNKsAkdCo'] }),
            pubsubPeerDiscovery({
                interval: 10000,
                topics: pubsubPeerDiscoveryTopics, // defaults to ['_peer-discovery._p2p._pubsub'] //if we enable this too many will connect to us!
                listenOnly: false
            })
        ]
      },
      datastore: new MemoryDatastore(),
      blockstore: new MemoryBlockstore(),
    });

    console.log('Peer ID:', helia.libp2p.peerId.toString());
    fs = unixfs(helia);
    pubsub = helia.libp2p.services.pubsub;

    await pubsub.subscribe(CONTENT_TOPIC);

    pubsub.addEventListener('message', (event) => {
      if (event.detail.topic === CONTENT_TOPIC) {
        const message = new TextDecoder().decode(event.detail.data);
        messages.push(message);
      }
    });
    
    // Wait a bit for the connection to establish
    await new Promise(resolve => setTimeout(resolve, 3000))
  });

  after(async () => {
    if(helia) await helia.stop();
  });

  it('should connect to the existing Helia node and check for specific peer', async function() {
    const peers = await helia.libp2p.getPeers()
    console.log(`Total number of peers: ${peers.length}`)
    expect(peers.length).to.be.at.least(1)

    const targetPeerId = '12D3KooWR7R2mMusGhtsXofgsdY1gzVgG2ykCfS7G5NnNKsAkdCo'
    
    let targetConnection = null

    // Check if the target peer is in the list of connected peers
    for (const peer of peers) {
        console.log(`Checking peer: ${peer.toString()}`)
        console.log(`Is this the target peer? ${peer.toString() === targetPeerId}`)
        
        if (peer.toString() === targetPeerId) {
            console.log('Target peer found in connected peers')
            targetConnection = peer
            break
        }
    }

    console.log(`Is target peer ${targetPeerId} connected: ${!!targetConnection}`)

    expect(targetConnection).to.exist
  })

  it('should add a file to IPFS and publish messages', async () => {
    const content = 'Hello, IPFS!';
    const cid = await fs.addBytes(uint8ArrayFromString(content));

    await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(`NEW-CID:${cid}`));

    await new Promise(resolve => setTimeout(resolve, 1000));

    expect(messages).to.include(`ADDING-CID:${cid}`);
    expect(messages).to.include(`ADDED-CID:${cid}`);
    expect(messages).to.include(`PINNING-CID:${cid}`);
    expect(messages).to.include(`PINNED-CID:${cid}`);

    let retrievedContent = '';
    for await (const chunk of fs.cat(cid)) {
      retrievedContent += new TextDecoder().decode(chunk);
    }
    expect(retrievedContent).to.equal(content);

  });

  it('should receive CIDs response when requesting LIST_TODAY', async function() {
      this.timeout(20000); // Increase timeout for this specific test
      messages.length = 0; // Clear messages array

      const today = moment().format('YYYY-MM-DD');
      console.log('Publishing LIST_TODAY message');
      await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode('LIST_TODAY'));

      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log(`Checking for response (attempt ${i + 1})`);
        console.log('Current messages:', messages);
        
        const todayCidsResponse = messages.find(msg => msg.startsWith(`${today}_CIDS:`));
        if (todayCidsResponse) {
          console.log('Received CIDs response for today:', todayCidsResponse);
          expect(todayCidsResponse).to.exist;

          if (todayCidsResponse === `${today}_CIDS:NONE`) {
            console.log('No CIDs found for today');
          } else {
            const cids = todayCidsResponse.split(':')[1].split(',');
            console.log(`Received ${cids.length} CIDs for today`);
            expect(cids.length).to.be.greaterThan(0);
          }
          return; // Exit the test if we got a response
        }
      }
      throw new Error('Did not receive CIDs response for today within the timeout period');
  });

  it('should receive CIDs response for the last 5 days', async function() {
    this.timeout(300000); 

    const days = 5;
    const startDate = moment('2024-10-05');

    for (let i = 0; i < days; i++) {
      const date = startDate.clone().subtract(i, 'days').format('YYYY-MM-DD');
      console.log(`Requesting CIDs for ${date}`);

      messages.length = 0; // Clear messages array
      await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(`LIST_DATE:${date}`));
      await new Promise(resolve => setTimeout(resolve, 5000));
      if (messages.length === 1 && messages[0] === `${date}_CIDS:NONE`) {
        console.log(`No name_ops found for ${date}`);
      } else {
        const nameOps = messages.flatMap(msg => {
          try {
            return JSON.parse(msg);
          } catch (e) {
            return [];
          }
        });

        console.log(`Received ${nameOps.length} name_ops for ${date}`);
        //console.log("nameOps:", JSON.stringify(nameOps, null, 2));
        
        expect(nameOps).to.be.an('array');
        expect(nameOps.length).to.be.greaterThan(0);
        
        nameOps.forEach(op => {
          expect(op).to.have.property('txid');
          expect(op).to.have.property('nameId');
        });
        
        console.log("nameIds:", nameOps.map(op => op.nameId).join(', '));
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  });

  it('should receive last 100 NameOps when requesting LIST_LAST_100', async function() {
    this.timeout(20000); 
    messages.length = 0; 

    console.log('Publishing LIST_LAST_100 message');
    await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode('LIST_LAST_100'));

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
});
