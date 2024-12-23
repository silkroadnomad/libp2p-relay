#!/bin/bash
set -e

echo "Starting doichaind in regtest mode..."
doichaind -regtest -daemon

echo "Waiting for doichaind to be ready..."
while ! doichain-cli -regtest -rpcuser=admin -rpcpassword=adminpw -rpcwait getblockchaininfo > /dev/null 2>&1; do
    echo "Waiting for doichaind..."
    sleep 1
done
echo "doichaind is ready!"

echo "Generating a new address..."
NEWADDR=$(doichain-cli -regtest -rpcuser=admin -rpcpassword=adminpw -rpcwait getnewaddress)

echo "Mining 200 blocks to $NEWADDR..."
doichain-cli -regtest -rpcuser=admin -rpcpassword=adminpw -rpcwait generatetoaddress 200 "$NEWADDR"

echo "Mined 200 blocks to $NEWADDR"

echo "Creating nameOps for Silk Road cities..."
CITIES=("Xi'an" "Dunhuang" "Kashgar" "Samarkand" "Bukhara" "Merv" "Baghdad" "Damascus" "Constantinople" "Venice" "Chang'an" "Karakorum" "Balkh" "Nishapur" "Ctesiphon" "Antioch" "Tyre" "Alexandria" "Rome" "Luoyang")

for city in "${CITIES[@]}"; do
    echo "Creating nameOp for $city..."
    TXID=$(doichain-cli -regtest -rpcuser=admin -rpcpassword=adminpw -rpcwait name_doi "$city" "value_for_$city")
    if [ $? -ne 0 ]; then
        echo "Failed to create nameOp for $city"
        exit 1
    fi
    echo "Created nameOp with txid: $TXID"
    
    # Mine a block to confirm the transaction
    BLOCK=$(doichain-cli -regtest -rpcuser=admin -rpcpassword=adminpw -rpcwait generatetoaddress 1 "$NEWADDR")
    if [ $? -ne 0 ]; then
        echo "Failed to mine block for $city nameOp"
        exit 1
    fi
    echo "Mined block $BLOCK to confirm nameOp for $city"
    
    # Verify the name exists
    NAME_INFO=$(doichain-cli -regtest -rpcuser=admin -rpcpassword=adminpw -rpcwait name_show "$city")
    if [ $? -ne 0 ]; then
        echo "Failed to verify nameOp for $city"
        exit 1
    fi
    echo "Verified nameOp exists for $city: $NAME_INFO"
done

echo "Created nameOps for all cities and mined confirmation blocks"

# Mine additional blocks periodically to ensure transactions are confirmed
echo "Starting periodic block mining..."
while true; do
    echo "Mining additional block..."
    doichain-cli -regtest -rpcuser=admin -rpcpassword=adminpw -rpcwait generatetoaddress 1 "$NEWADDR"
    sleep 30
done
