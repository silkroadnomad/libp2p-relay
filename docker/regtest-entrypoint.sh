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

echo "Creating nameOps for Silk Road cities..."
CITIES=("Xi'an" "Dunhuang" "Kashgar" "Samarkand" "Bukhara" "Merv" "Baghdad" "Damascus" "Constantinople" "Venice" "Chang'an" "Karakorum" "Balkh" "Nishapur" "Ctesiphon" "Antioch" "Tyre" "Alexandria" "Rome" "Luoyang")

for city in "${CITIES[@]}"; do
    echo "Creating nameOp for $city..."
    doichain-cli -regtest -rpcuser=admin -rpcpassword=adminpw -rpcwait name_doi "$city" "value_for_$city"
    # Mine a block to confirm the transaction
    doichain-cli -regtest -rpcuser=admin -rpcpassword=adminpw -rpcwait generatetoaddress 1 "$NEWADDR"
done

echo "Created nameOps for all cities and mined confirmation blocks"

# Keep process alive so container doesn't exit
echo "Tailing debug.log to keep container running..."
tail -f /home/doichain/.doichain/regtest/debug.log
