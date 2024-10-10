import { writable } from 'svelte/store';

export const libp2p = writable()
export const helia = writable()
export const connectedPeers = writable(0);
export const scanOpen = writable(false)
export const scanData = writable()
export const network = writable(DOICHAIN);
export const connectedServer = writable('offline')
export const electrumClient = writable();
export const electrumServerVersion = writable('');
export const electrumServerBanner = writable('disconnected');
export const electrumBlockchainBlockHeadersSubscribe = writable()
export const electrumBlockchainRelayfee = writable();
export const electrumBlockchainBlockHeaders = writable();


