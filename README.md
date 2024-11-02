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
    - SERVER_NAME=your-server-ipnsInstance.domain.xyz
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
- [x] pin only when nameOps arrive and inform network by pubusb  
- [ ] install on a RaspberryPI
- [x] nameop_cids and failed_cids should go into a OrbitDB. So we can use the scanning functions also in every peer (e.g. browser and mobile app)
- [ ] tipWatcher:  when every a new block comes in the scan should be resarted. (Remark: src/pinner/tipWatcher already implemented but functionality not reviewed nor untestet)
- [x] when a scan is discovering a nameOp it should write it into data/failed_cids.json
  - [ ] write a test 
- [x] when a peer connects it retries failed and removes successful loads from data/failed_cids.json
  - [ ] write a test
- [x] display also "unconfirmed"
- [x] the relay is scanning Doichain blockchain for name-ops
- [x] if a name-ops is being found, it needs to be investigated 
  - [x] create a file which contains all name-ops of today an ipns name-ops (with the today date e.g. 2024-10-09) and references the files cid
  - [x] everytime a new name-ops is found this file is being added again and the new resulting cid updated to the ipns name-ops
  - [x] if name-op contains an ipfs:// url the CID needs to be gathered from the ipfs node (or the network)
    - [x] if its available wie pin it  
    - [x] or if its not we store the cid in failed-cids 
- [x] every browser can call LIST-DATE (e.g. LIST-20241014) 
- [x] every relay who has the name_ops of today is publishing it (not sure if that is efficient enough)
- [ ] every browser should also index the blockchain for name_ops (like the relay does) and answer for requests
- [ ] question is: how much should every browser cache
- [x] pinner should only pin if cid is inside of nameOp transaction 
- [ ] pinner should only pin if cid is inside of nameOP transaction and a minimum fee per kb is paid to a certain doichain address (tx contains vout)