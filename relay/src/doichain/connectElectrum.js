import { ElectrumxClient } from './electrumx-client.js';
import { electrumServers } from "./doichain.js";

const MAX_RETRIES = 25;
const RETRY_DELAY = 5000;

/*
<script>
	import { connectElectrum } from './doichain/connectElectrum.js';
	import {
		electrumBlockchainBlockHeadersSubscribe,
		electrumBlockchainRelayfee,
		electrumClient,
		electrumServerBanner,
		electrumServerVersion, network, connectedServer
	} from './doichain-store.js';

	const updateStore = (key, value) => {
		switch (key) {
			case 'electrumClient':
				electrumClient.set(value);
				break;
			case 'electrumServerVersion':
				electrumServerVersion.set(value);
				break;
			case 'connectedServer':
				connectedServer.set(value);
				break;
			case 'electrumServerBanner':
				electrumServerBanner.set(value);
				break;
			case 'electrumBlockchainBlockHeadersSubscribe':
				electrumBlockchainBlockHeadersSubscribe.set(value);
				break;
			case 'electrumBlockchainRelayfee':
				electrumBlockchainRelayfee.set(value);
				break;
		}
	};

	// Example usage
	$: connectElectrum($network, updateStore);
	*/

export const connectElectrum = async (_network, updateStore) => {
	if (!_network) return;
	
	let retries = 0;
	let randomServer;
	let _electrumClient;
	while (retries < MAX_RETRIES) {

		const networkNodes = electrumServers.filter(n => n.network === _network.name);
		randomServer = networkNodes[Math.floor(Math.random() * networkNodes.length)];
		_electrumClient = new ElectrumxClient(randomServer.host, randomServer.port, randomServer.protocol);

		try {
			await _electrumClient.connect("electrum-client-js", "1.4.2");
			updateStore('electrumClient', _electrumClient);
			break;
		} catch (error) {
			console.error("Connection failed, retrying...", error);
			retries++;
			if (retries < MAX_RETRIES) {
				updateStore('electrumServerVersion', `retrying (${retries})`);
				updateStore('connectedServer', `retrying (${retries} - ${randomServer.host})`);
				await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
			} else {
				throw new Error("Max retries reached. Unable to connect to Electrum server.");
			}
		}
	}

	const _electrumServerVersion = await _electrumClient.request('server.version');
	updateStore('electrumServerVersion', _electrumServerVersion);
	console.log("electrumServerVersion", _electrumServerVersion);

	const _connectedServer = `${randomServer.protocol}://${randomServer.host}:${randomServer.port}`;
	updateStore('connectedServer', _connectedServer);
	console.log("network", _connectedServer);

	const _electrumServerBanner = await _electrumClient.request('server.banner');
	console.log("electrumServerBanner", _electrumServerBanner);
	updateStore('electrumServerBanner', _electrumServerBanner);

	const _electrumBlockchainBlockHeadersSubscribe = await _electrumClient.request('blockchain.headers.subscribe');
	updateStore('electrumBlockchainBlockHeadersSubscribe', _electrumBlockchainBlockHeadersSubscribe);

	const _electrumBlockchainRelayfee = await _electrumClient.request('blockchain.relayfee');
	updateStore('electrumBlockchainRelayfee', _electrumBlockchainRelayfee);

	return _electrumClient;
};