import { expect } from 'chai';
import sinon from 'sinon';
import { PinningService } from '../../src/pinner/pinningService.js';

describe('PinningService', () => {
  let sandbox;
  let pinningService;
  let mockHelia;
  let mockOrbitdb;
  let mockElectrumClient;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockHelia = {
      blockstore: {
        put: sandbox.stub().resolves(),
        get: sandbox.stub().resolves()
      }
    };
    mockOrbitdb = {
      id: 'test-id',
      identity: { id: 'test-identity' }
    };
    mockElectrumClient = {
      request: sandbox.stub().resolves()
    };
    
    pinningService = new PinningService(mockHelia, mockOrbitdb, mockElectrumClient);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('calculatePinningFee', () => {
    it('should calculate fee based on size and duration', () => {
      const size = 1024 * 1024; // 1MB
      const duration = 30; // 30 days
      
      const fee = pinningService.calculatePinningFee(size, duration);
      
      expect(fee).to.be.a('number');
      expect(fee).to.be.greaterThan(0);
    });
  });

  describe('pinContent', () => {
    it('should pin content successfully', async () => {
      const cid = 'QmPZv7P8nQUSh6E3dGXhE3k8SqF6kY4GKH5bmFtX9DVQeH';
      const duration = 30;
      
      await pinningService.pinContent(cid, duration);
      
      expect(mockHelia.blockstore.put.called).to.be.true;
    });
  });
});
