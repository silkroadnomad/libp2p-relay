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
        put: sandbox.stub().resolves(Buffer.from('test')),
        get: sandbox.stub().resolves(Buffer.from('test')),
        has: sandbox.stub().resolves(true)
      },
      dag: {
        get: sandbox.stub().resolves({ value: Buffer.from('test') }),
        put: sandbox.stub().resolves()
      }
    };
    mockOrbitdb = {
      open: sandbox.stub().resolves({
        add: sandbox.stub().resolves('hash'),
        get: sandbox.stub().resolves({ value: 'test' }),
        close: sandbox.stub().resolves()
      }),
      close: sandbox.stub().resolves(),
      id: 'test-id',
      identity: { id: 'test-identity' }
    };
    mockElectrumClient = {
      request: sandbox.stub().resolves(),
      connect: sandbox.stub().resolves(),
      close: sandbox.stub().resolves(),
      blockchain_scripthash_subscribe: sandbox.stub().resolves(),
      blockchain_scripthash_get_history: sandbox.stub().resolves([])
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
      const mockCid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
      const duration = 30;
      
      await pinningService.pinContent(mockCid, duration);
      
      expect(mockHelia.blockstore.put.called).to.be.true;
    });
  });
});
