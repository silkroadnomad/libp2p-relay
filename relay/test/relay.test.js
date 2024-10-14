import { expect } from 'chai';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string';
import { MemoryBlockstore } from 'blockstore-core';
import { MemoryDatastore } from 'datastore-core';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { bootstrap } from "@libp2p/bootstrap"
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery"

const pubsubPeerDiscoveryTopics = process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS?.split(',')
const CONTENT_TOPIC = '/doichain-nfc/1/message/proto';

describe('Helia IPNS Node Test', function() {
  this.timeout(100000); // Increase timeout for IPFS operations

  let helia, fs, pubsub;
  const messages = [];

  before(async function() {
    this.timeout(100000);
    // Create Helia node
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
//can we log the peer id?
console.log('Peer ID:', helia.libp2p.peerId.toString());
   // const existingNodeAddr = multiaddr('/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWR7R2mMusGhtsXofgsdY1gzVgG2ykCfS7G5NnNKsAkdCo')
   //  await helia.libp2p.dial(existingNodeAddr)
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
    const peers = await helia.libp2p.peerStore.all()
    expect(peers.length).to.be.at.least(1)

    const targetPeerId = '12D3KooWR7R2mMusGhtsXofgsdY1gzVgG2ykCfS7G5NnNKsAkdCo'
    const targetPeer = peerIdFromString(targetPeerId)
    
    let isTargetPeerConnected = false
    let targetPeerInfo = null

    // Check if the target peer is connected and log its multiaddrs
    for (const peer of peers) {
        console.log('current peer id:',peer.id.toString())
      if (peer.id.toString() === targetPeerId) {
        isTargetPeerConnected = true
        targetPeerInfo = await helia.libp2p.peerStore.get(peer.id)
        break
      }
    }

    console.log(`Is target peer ${targetPeerId} connected: ${isTargetPeerConnected}`)

    if (isTargetPeerConnected && targetPeerInfo) {
      console.log('Target peer multiaddrs:')
      for (const addr of targetPeerInfo.addresses) {
        console.log(addr.multiaddr.toString())
      }
    } else {
      console.log('Target peer not found in connected peers')
    }

    // Optional: Assert that the target peer is connected
    expect(isTargetPeerConnected).to.be.true
  })

  it('should add a file to IPFS and publish messages', async () => {
    const content = 'Hello, IPFS!';
    const cid = await fs.addBytes(uint8ArrayFromString(content));

    // Simulate the message handling process
    await pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(`NEW-CID:${cid}`));

    // Wait for all messages to be processed
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check if all expected messages were published
    expect(messages).to.include(`ADDING-CID:${cid}`);
    expect(messages).to.include(`ADDED-CID:${cid}`);
    expect(messages).to.include(`PINNING-CID:${cid}`);
    expect(messages).to.include(`PINNED-CID:${cid}`);

    // Verify the content
    let retrievedContent = '';
    for await (const chunk of fs.cat(cid)) {
      retrievedContent += new TextDecoder().decode(chunk);
    }
    expect(retrievedContent).to.equal(content);

    // // Check if the CID is pinned
    // const pinnedBlocks = [];
    // for await (const pin of helia.pins.ls()) {
    //   pinnedBlocks.push(pin);
    // }
    // expect(pinnedBlocks).to.deep.include(cid);
  });

});
