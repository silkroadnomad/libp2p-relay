FROM node:20

# Install netcat for connection checks
RUN apt-get update && apt-get install -y netcat-openbsd && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY relay/ ./
COPY docker/entrypoint.sh ./
COPY relay/.env.example ./.env

# Make entrypoint script executable and install dependencies
RUN chmod +x ./entrypoint.sh && \
    rm -rf node_modules && \
    npm install

ENTRYPOINT [ "./entrypoint.sh" ]
CMD [ "node", "src/relay.js"]
