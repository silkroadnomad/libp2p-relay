import { ElectrumxClient } from './electrumx-client.js';
import { electrumServers } from "./doichain.js";
import logger from '../logger.js';

const MAX_RETRIES = 25;
const RETRY_DELAY = 5000;

let currentServerIndex = -1;
let connectedClients = [];

export const useNextElectrum = async (_network, updateStore) => {
	if (!_network) {
		logger.info('useNextElectrum: No network provided', { network: _network });
		return null;
	}

	const networkNodes = electrumServers.filter(n => n.network === _network.name);
	
	if (networkNodes.length === 0) {
		logger.warn('useNextElectrum: No Electrum servers available for the given network', { network: _network.name });
		throw new Error("No Electrum servers available for the given network.");
	}

	currentServerIndex = (currentServerIndex + 1) % networkNodes.length;
	const nextServer = networkNodes[currentServerIndex];

	// Check if we already have a connected client for this server
	let existingClient = connectedClients.find(c => 
		c.host === nextServer.host && 
		c.port === nextServer.port && 
		c.protocol === nextServer.protocol
	);

	if (existingClient) {
		return existingClient;
	}

	// If not, create a new client and connect
	const newClient = new ElectrumxClient(nextServer.host, nextServer.port, nextServer.protocol);

	try {
		await newClient.connect("electrum-client-js", "1.4.2");
		connectedClients.push(newClient);
		updateStore('electrumClient', newClient);

		logger.info('useNextElectrum: Connected to new Electrum server', {
			host: nextServer.host,
			port: nextServer.port,
			protocol: nextServer.protocol
		});

		// Remove this line as it's causing the duplicate server.version request
		// const serverVersion = await newClient.request('server.version');
		// updateStore('electrumServerVersion', serverVersion);

		const connectedServer = `${nextServer.protocol}://${nextServer.host}:${nextServer.port}`;
		updateStore('connectedServer', connectedServer);

		return newClient;
	} catch (error) {
		logger.error('useNextElectrum: Failed to connect to Electrum server', {
			host: nextServer.host,
			port: nextServer.port,
			protocol: nextServer.protocol,
			error: error.message
		});
		// If connection fails, try the next server
		return useNextElectrum(_network, updateStore);
	}
};

export const connectElectrum = async (_network, updateStore) => {
	if (!_network) return;
	
	let retries = 0;
	let _electrumClient;

	while (retries < MAX_RETRIES) {
		try {
			_electrumClient = await useNextElectrum(_network, updateStore);
			
			const _electrumServerVersion = await _electrumClient.request('server.version');
			updateStore('electrumServerVersion', _electrumServerVersion);
			console.log("electrumServerVersion", _electrumServerVersion);

			const _connectedServer = `${_electrumClient.protocol}://${_electrumClient.host}:${_electrumClient.port}`;
			updateStore('connectedServer', _connectedServer);
			console.log("network", _connectedServer);

			const _electrumServerBanner = await _electrumClient.request('server.banner');
			console.log("electrumServerBanner", _electrumServerBanner);
			updateStore('electrumServerBanner', _electrumServerBanner);

			const _electrumBlockchainBlockHeadersSubscribe = await _electrumClient.request('blockchain.headers.subscribe');
			updateStore('electrumBlockchainBlockHeadersSubscribe', _electrumBlockchainBlockHeadersSubscribe);

			const _electrumBlockchainRelayfee = await _electrumClient.request('blockchain.relayfee');
			updateStore('electrumBlockchainRelayfee', _electrumBlockchainRelayfee);

			break; // Exit the retry loop if successful
		} catch (error) {
			console.error("Connection failed, retrying...", error);
			retries++;
			if (retries < MAX_RETRIES) {
				updateStore('electrumServerVersion', `retrying (${retries})`);
				updateStore('connectedServer', `retrying (${retries})`);
				await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
			} else {
				throw new Error("Max retries reached. Unable to connect to any Electrum server.");
			}
		}
	}

	return _electrumClient;
};
