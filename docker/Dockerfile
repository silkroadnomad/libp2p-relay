FROM node:20
WORKDIR /usr/src/app
COPY relay/ ./
COPY docker/entrypoint.sh ./
COPY relay/.env.example ./.env
RUN rm -rf node_modules && npm install
ENTRYPOINT [ "./entrypoint.sh" ]
CMD [ "node", "src/relay.js"]
