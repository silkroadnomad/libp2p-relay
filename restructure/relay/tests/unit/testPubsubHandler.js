import { expect } from 'chai';
import sinon from 'sinon';
import { setupPubsub } from '../../src/pubsubHandler.js';
import { testConfig } from '../test-config.js';

describe('PubsubHandler', () => {
  let sandbox;
  let mockNode;
  let mockPinningService;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockNode = {
      libp2p: {
        services: {
          pubsub: {
            subscribe: sandbox.stub().resolves(),
            publish: sandbox.stub().resolves(),
            addEventListener: sandbox.stub(),
            removeEventListener: sandbox.stub(),
            topics: new Set(),
            start: sandbox.stub().resolves(),
            stop: sandbox.stub().resolves()
          },
          identify: {
            multicodecs: ['/noise'],
            start: sandbox.stub().resolves(),
            stop: sandbox.stub().resolves()
          }
        },
        connectionManager: {
          getConnections: sandbox.stub().returns([]),
          addEventListener: sandbox.stub(),
          removeEventListener: sandbox.stub()
        },
        peerId: {
          toString: () => 'QmTestPeerId',
          toBytes: () => new Uint8Array([1, 2, 3]),
          type: 'Ed25519'
        },
        start: sandbox.stub().resolves(),
        stop: sandbox.stub().resolves(),
        getMultiaddrs: () => []
      }
    };
    mockPinningService = {
      pinContent: sandbox.stub().resolves(),
      calculatePinningFee: sandbox.stub().returns(1000)
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('setupPubsub', () => {
    it('should subscribe to the correct topics', async () => {
      await setupPubsub(mockNode, mockPinningService);
      expect(mockNode.services.pubsub.subscribe.called).to.be.true;
    });

    it('should handle incoming messages correctly', async () => {
      const message = {
        data: new TextEncoder().encode(JSON.stringify({
          action: 'pin',
          cid: 'QmTest',
          duration: 30
        }))
      };
      
      await setupPubsub(mockNode, mockPinningService);
      const messageHandler = mockNode.services.pubsub.addEventListener.getCall(0).args[1];
      await messageHandler(message);
      
      expect(mockPinningService.pinContent.called).to.be.true;
    });

    it('should handle invalid messages gracefully', async () => {
      const invalidMessage = {
        data: new TextEncoder().encode('invalid json')
      };
      
      await setupPubsub(mockNode, mockPinningService);
      const messageHandler = mockNode.services.pubsub.addEventListener.getCall(0).args[1];
      
      expect(() => messageHandler(invalidMessage)).to.not.throw();
    });
  });
});
