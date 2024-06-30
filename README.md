# Websocket libp2p-relay

## Description 

This is a docker image and docker compose file which runs a 
- NodeJS websocket relay for libp2p with 
- nginx and
- letsencrypt

## Usage
### via nodejs
0. Copy .env.example to .env and change according to your environment
    - RELAY_DEV_MODE=true in order to disable gossip-sub tresholds
    - SERVER_NAME=your-server-name.domain.xyz
    - RELAY_PUBSUB_PEER_DISCOVERY_TOPICS=your-topic._peer-discovery._p2p._pubsub
    - RELAY_PRIVATE_KEY=how to generate a good private key for your node?
1. Run ```node relay/src/relay.js```
2. Run ```DEBUG=libp2p:* node relay/src/relay.js```  (for debug mode) or

### Docker
0. Copy .env.example to .env and change to your environment
1. Modify init-letsencrypt.sh (domains=(ipfs.le-space.de) around line 8) to setup your letsencrypt domain 
2. Run ```./init-letsencrypt.sh``` (letsencrypt is creating ssl certificates for nginx)
3. Run ```docker-compose up -d``` (nginx, letsencrypt, relay-service starting)
4. Run ```docker-compose logs``` and find the libp2p address to connect your peers

### Ideas
When starting a relay-node for libp2p, it would be nice to have place where other peers could find the multi address of our new peer.
It is also the case that webtransport and webrtc peers and generate new hashes to connect. (E.g. webtransport hashes need to renewed every 2 weeks).

The idea is now to store those multi addresses on a blockchain such as Bitcoin (via Ordinals) or Doichain (a merged-mining Namecoin fork)

What will it do?
1. During start, connect to the blockchain (e.g., Electrumx) and query a certain namespace for seed nodes and 
2. If our node is not yet stored on blockchain and a private key is inside .env it should send a transaction to a blockchain

FAQ:
- Q: Can everybody store a relay nodes multi-address? 
  - A: Yes, everybody should.
- Q: What if the seed node / relay node is a malicious node and try to connect peers with malicious peers? 
  - A: Every peer in the network must be regarded as malicious, it's on the peer's consensus to prevent malicious actions.
  - A: If a big number of malicious relay nodes appear on blockchain, they could prevent others from connecting to the real network.
    - Q: Are there any measures taken by libp2p / gossip sub protocol? 
    - A: Needs more research: 
      - a peer connecting successfully to a relay could ping other relays in the list before connecting.
      - if the pinged peer isn't responding, it either means it is offline or not connected to the network and put it in 'quarantine.'
      - if direct dialing cannot connect to the peers in quarantine means they are offline 
      - the list of leftovers could be regarded as malicious (or being the right network, in case we are connected to the wrong network)