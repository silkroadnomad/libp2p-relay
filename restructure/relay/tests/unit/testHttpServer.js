import { expect } from 'chai';
import sinon from 'sinon';
import { createHttpServer } from '../../src/httpServer.js';
import express from 'express';

describe('HttpServer', () => {
  let sandbox;
  let mockExpress;
  let mockNode;
  let mockPinningService;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockExpress = {
      get: sandbox.stub(),
      post: sandbox.stub(),
      use: sandbox.stub(),
      listen: sandbox.stub()
    };
    mockNode = {
      peerId: { toString: () => 'testPeerId' },
      getMultiaddrs: sandbox.stub().returns(['testAddr'])
    };
    mockPinningService = {
      pinContent: sandbox.stub().resolves(),
      calculatePinningFee: sandbox.stub().returns(1000)
    };
    
    sandbox.stub(express, 'Router').returns(mockExpress);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('createHttpServer', () => {
    it('should set up routes correctly', () => {
      createHttpServer(mockNode, mockPinningService);
      
      expect(mockExpress.get.called).to.be.true;
      expect(mockExpress.post.called).to.be.true;
    });

    it('should handle pin requests correctly', async () => {
      const mockReq = {
        body: {
          cid: 'QmTest',
          duration: 30
        }
      };
      const mockRes = {
        json: sandbox.stub(),
        status: sandbox.stub().returnsThis()
      };

      createHttpServer(mockNode, mockPinningService);
      const pinHandler = mockExpress.post.getCall(0).args[1];
      await pinHandler(mockReq, mockRes);
      
      expect(mockPinningService.pinContent.called).to.be.true;
      expect(mockRes.json.called).to.be.true;
    });

    it('should handle errors gracefully', (done) => {
      const mockReq = {
        body: { invalid: 'request' }
      };
      const mockRes = {
        json: sandbox.stub(),
        status: sandbox.stub().returnsThis()
      };

      createHttpServer(mockNode, mockPinningService);
      const pinHandler = mockExpress.post.getCall(0).args[1];
      
      pinHandler(mockReq, mockRes)
        .then(() => {
          expect(mockRes.status.calledWith(400)).to.be.true;
          done();
        })
        .catch(done);
    });
  });
});
