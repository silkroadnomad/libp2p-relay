#!/bin/bash 
rm scanning-state.json

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
    npm run start
elif [ "$1" == "start" ]; then
    echo "Starting node..."
    npm run start
else
    echo "Invalid command. Use 'generate-key' or 'start'."
    exit 1
fi

# Start the application if a valid command was provided
# exec "$@"