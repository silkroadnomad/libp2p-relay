import { expect } from 'chai';
import sinon from 'sinon';
import { createNode } from '../../src/nodeFactory.js';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';

describe('NodeFactory', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('createNode', () => {
    it('should create a node with correct configuration', async () => {
      // Test implementation
      const node = await createNode();
      
      expect(node).to.exist;
      expect(node.services).to.have.property('pubsub');
      expect(node.services).to.have.property('identify');
      expect(node.connectionManager).to.exist;
    });

    it('should configure transport protocols correctly', async () => {
      const node = await createNode();
      
      expect(node.transportManager.getTransports()).to.have.lengthOf.at.least(2);
      expect(node.services.identify).to.exist;
    });

    it('should initialize with correct connection encryption', async () => {
      const node = await createNode();
      
      expect(node.connectionEncrypter).to.exist;
      expect(node.services.identify.multicodecs).to.include('/noise');
    });
  });
});
