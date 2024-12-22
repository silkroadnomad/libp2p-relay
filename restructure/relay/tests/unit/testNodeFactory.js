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
      const config = {
        ...mockLibp2pConfig,
        privKeyHex: process.env.RELAY_PRIVATE_KEY,
        datastore: {
          open: () => Promise.resolve(),
          close: () => Promise.resolve()
        },
        blockstore: {
          open: () => Promise.resolve(),
          close: () => Promise.resolve()
        }
      };
      
      const { helia, orbitdb, pinningService } = await createNode(config);
      
      expect(helia).to.exist;
      expect(orbitdb).to.exist;
      expect(pinningService).to.exist;
    });

    it('should handle missing optional parameters', async () => {
      const config = {
        privKeyHex: process.env.RELAY_PRIVATE_KEY,
        datastore: {
          open: () => Promise.resolve(),
          close: () => Promise.resolve()
        }
      };
      
      const { helia, orbitdb, pinningService } = await createNode(config);
      
      expect(helia).to.exist;
      expect(orbitdb).to.exist;
      expect(pinningService).to.exist;
    });

    it('should throw error with invalid private key', async () => {
      const config = {
        privKeyHex: 'invalid-key',
        datastore: {
          open: () => Promise.resolve(),
          close: () => Promise.resolve()
        }
      };
      
      try {
        await createNode(config);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.include('Invalid private key format');
      }
    });
  });
});
