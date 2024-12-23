#!/bin/bash 
rm -f scanning-state.json

# Function to check if ElectrumX is ready
check_electrumx() {
    nc -z electrumx 8443 2>/dev/null
    return $?
}

# Function to wait for ElectrumX with timeout
wait_for_electrumx() {
    echo "Waiting for ElectrumX to be ready..."
    local timeout=60
    local count=0
    while ! check_electrumx; do
        count=$((count + 1))
        if [ $count -gt $timeout ]; then
            echo "Timeout waiting for ElectrumX"
            return 1
        fi
        echo "Attempt $count/$timeout: ElectrumX not ready yet..."
        sleep 1
    done
    echo "ElectrumX is ready!"
    return 0
}

if [ "$1" == "generate-key" ]; then
    echo "Generating private key..."
    npm run generate-keypair
    echo "--------------------------------"
    key_output=$(cat .env.privateKey)

    echo "Private key generated: $key_output"
    # Replace or add the RELAY_PRIVATE_KEY in the .env file
    if grep -q "^RELAY_PRIVATE_KEY=" .env; then
        sed -i "s/^RELAY_PRIVATE_KEY=.*/$key_output/" .env
    else
        echo "$key_output" >> .env
    fi
    cat .env

    # Wait for ElectrumX to be ready before starting
    if wait_for_electrumx; then
        echo "Starting relay service..."
        npm run start
    else
        echo "Failed to connect to ElectrumX"
        exit 1
    fi
elif [ "$1" == "start" ]; then
    echo "Starting node..."
    # Wait for ElectrumX to be ready before starting
    if wait_for_electrumx; then
        npm run start
    else
        echo "Failed to connect to ElectrumX"
        exit 1
    fi
else
    echo "Invalid command. Use 'generate-key' or 'start'."
    exit 1
fi
