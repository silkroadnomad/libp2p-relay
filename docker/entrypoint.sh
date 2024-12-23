#!/bin/bash 
rm -f scanning-state.json

# Function to check if basic services are ready
check_basic_services() {
    nc -z electrumx 8443 2>/dev/null && nc -z regtest 18443 2>/dev/null
    return $?
}

# Function to check if relay service is ready
check_relay_service() {
    # Check both HTTP and libp2p ports
    (nc -z localhost 3000 2>/dev/null && nc -z localhost 9090 2>/dev/null && nc -z localhost 9091 2>/dev/null) || return 1
    
    # Try to get nameOps count from HTTP API
    response=$(curl -s http://localhost:3000/api/v1/nameops/count 2>/dev/null)
    if [ $? -eq 0 ] && [ "$response" != "" ]; then
        echo "Relay API responding with nameOps count: $response"
        return 0
    fi
    return 1
}

# Function to wait for services with timeout
wait_for_services() {
    echo "Waiting for basic services to be ready..."
    local timeout=180
    local count=0
    
    # First wait for ElectrumX and regtest
    while ! check_basic_services; do
        count=$((count + 1))
        if [ $count -gt $timeout ]; then
            echo "Timeout waiting for ElectrumX and regtest"
            return 1
        fi
        echo "Attempt $count/$timeout: Waiting for ElectrumX and regtest..."
        sleep 1
    done
    echo "ElectrumX and regtest are ready!"
    
    # Then wait for relay service to be ready
    count=0
    echo "Starting relay service..."
    npm run start &
    
    echo "Waiting for relay service to initialize..."
    while ! check_relay_service; do
        count=$((count + 1))
        if [ $count -gt $timeout ]; then
            echo "Timeout waiting for relay service"
            return 1
        fi
        echo "Attempt $count/$timeout: Waiting for relay service..."
        sleep 1
    done
    echo "Relay service is ready!"
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

    # When generating key, just do that and exit
    echo "Private key generated: $key_output"
    exit 0
elif [ "$1" == "start" ]; then
    echo "Starting node..."
    # Wait for services and start only once
    if ! wait_for_services; then
        echo "Failed to connect to required services"
        exit 1
    fi
    
    # Start the service (only once)
    npm run start
else
    echo "Invalid command. Use 'generate-key' or 'start'."
    exit 1
fi
