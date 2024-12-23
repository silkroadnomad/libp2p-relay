#!/bin/bash
set -e

echo "Starting doichaind in regtest mode..."
doichaind -regtest -daemon

echo "Waiting 5s for doichaind to be ready..."
sleep 5

echo "Generating a new address..."
NEWADDR=$(doichain-cli -regtest -rpcuser=admin -rpcpassword=adminpw -rpcwait getnewaddress)

echo "Mining 200 blocks to $NEWADDR..."
doichain-cli -regtest -rpcuser=admin -rpcpassword=adminpw -rpcwait generatetoaddress 200 "$NEWADDR"

echo "Mined 200 blocks to $NEWADDR"

# Keep process alive so container doesn't exit
echo "Tailing debug.log to keep container running..."
tail -f /home/doichain/.doichain/regtest/debug.log
