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

# Adaptation of this relay
- [x] the relay is scanning Doichain blockchain for name-ops
- [ ] if a name-op is being found, it needs to be investigated 
  - [ ] create a file which contains all name-ops of today an ipns name (with the today date e.g. 2024-10-09) and references the files cid
  - [ ] everytime a new name-op is found this file is being added again and the new resulting cid updated to the ipns name
  - [ ] if its value contains an ipfs:// url the CID 