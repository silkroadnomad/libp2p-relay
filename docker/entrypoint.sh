#!/bin/bash 
rm -f scanning-state.json

# Function to check if services are ready
check_services() {
    nc -z electrumx 8443 2>/dev/null && nc -z regtest 18443 2>/dev/null
    return $?
}

# Function to wait for services with timeout
wait_for_services() {
    echo "Waiting for services to be ready..."
    local timeout=120
    local count=0
    while ! check_services; do
        count=$((count + 1))
        if [ $count -gt $timeout ]; then
            echo "Timeout waiting for services"
            return 1
        fi
        echo "Attempt $count/$timeout: Services not ready yet..."
        sleep 1
    done
    echo "All services are ready!"
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

    # Wait for all services to be ready before starting
    if wait_for_services; then
        echo "Starting relay service..."
        npm run start
    else
        echo "Failed to connect to required services"
        exit 1
    fi
elif [ "$1" == "start" ]; then
    echo "Starting node..."
    # Wait for all services to be ready before starting
    if wait_for_services; then
        npm run start
    else
        echo "Failed to connect to required services"
        exit 1
    fi
else
    echo "Invalid command. Use 'generate-key' or 'start'."
    exit 1
fi
