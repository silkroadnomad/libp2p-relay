FROM node:21
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY src .

# Your application runs on port 12345, so you'll use the EXPOSE instruction to have it mapped by the docker daemon
EXPOSE 12345

# Command to run your app
CMD [ "node", "relay.js" ]
