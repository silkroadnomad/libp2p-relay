FROM node:20
WORKDIR /usr/src/app
COPY relay/ ./
RUN npm install

# Your application runs on port 12345, so you'll use the EXPOSE instruction to have it mapped by the docker daemon
EXPOSE 12345 3000

# Command to run your app
CMD [ "node", "relay/src/relay.js" ]
#CMD [ "ls", "-l" ]
