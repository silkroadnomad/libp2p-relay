import { expect } from 'chai';
import sinon from 'sinon';
import { createNode } from '../../src/nodeFactory.js';
import { testConfig, mockLibp2pConfig } from '../test-config.js';

describe('NodeFactory', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('createNode', () => {
    beforeEach(() => {
      // Set up environment variables
      process.env.RELAY_DEV_MODE = testConfig.relayDevMode;
      process.env.SERVER_NAME = testConfig.serverName;
      process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS = testConfig.relayPubsubPeerDiscoveryTopics;
      process.env.RELAY_PRIVATE_KEY = testConfig.relayPrivateKey;
      process.env.RELAY_BOOTSTRAP_LIST = testConfig.bootstrapList.join(',');
    });

    afterEach(() => {
      // Clean up environment variables
      delete process.env.RELAY_DEV_MODE;
      delete process.env.SERVER_NAME;
      delete process.env.RELAY_PUBSUB_PEER_DISCOVERY_TOPICS;
      delete process.env.RELAY_PRIVATE_KEY;
      delete process.env.RELAY_BOOTSTRAP_LIST;
    });

    it('should create a node with correct configuration', async () => {
      const node = await createNode(mockLibp2pConfig);
      
      expect(node).to.exist;
      expect(node.services).to.have.property('pubsub');
      expect(node.services).to.have.property('identify');
      expect(node.connectionManager).to.exist;
    });

    it('should configure transport protocols correctly', async () => {
      const node = await createNode(mockLibp2pConfig);
      
      expect(node.transportManager).to.exist;
      expect(node.services.identify).to.exist;
    });

    it('should initialize with correct connection encryption', async () => {
      const node = await createNode(mockLibp2pConfig);
      
      expect(node.connectionEncrypter).to.exist;
      expect(node.services.identify).to.exist;
    });
  });
});
