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
      services: {
        pubsub: {
          subscribe: sandbox.stub().resolves(),
          publish: sandbox.stub().resolves(),
          addEventListener: sandbox.stub(),
          topics: new Set()
        },
        identify: {
          multicodecs: ['/noise']
        }
      },
      connectionManager: {
        getConnections: sandbox.stub().returns([])
      },
      peerId: {
        toString: () => 'QmTestPeerId'
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
