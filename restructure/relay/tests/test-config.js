// Test configuration for libp2p-relay
export const testConfig = {
  relayDevMode: true,
  serverName: 'test-server',
  relayPubsubPeerDiscoveryTopics: 'test-topic',
  relayPrivateKey: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  bootstrapList: ['/ip4/127.0.0.1/tcp/63785/p2p/12D3KooWRBxYrPDRsLS9PSK3H8YQpKYHTrzK7J2kgjJwGp8JmpHR'],
  pubsubPeerDiscoveryTopics: ['test-topic'],
  scoreThresholds: {
    gossipThreshold: -500,
    publishThreshold: -1000,
    graylistThreshold: -2500,
    acceptPXThreshold: 1000,
    opportunisticGraftThreshold: 3.5
  }
};

export const mockLibp2pConfig = {
  addresses: {
    listen: ['/ip4/127.0.0.1/tcp/0'],
    announce: []
  },
  datastore: {
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    put: () => Promise.resolve(),
    get: () => Promise.resolve()
  },
  metrics: {
    enabled: false
  },
  connectionManager: {
    maxConnections: 50,
    minConnections: 0,
    maxDialTimeout: 30000
  },
  services: {
    identify: {
      multicodecs: ['/noise']
    },
    pubsub: {
      enabled: true
    }
  }
};
