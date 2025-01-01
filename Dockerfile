FROM node:20
WORKDIR /usr/src/app
COPY relay/ ./
RUN npm install
EXPOSE 12345 3000
CMD [ "node", "relay/src/relay.js" ]
