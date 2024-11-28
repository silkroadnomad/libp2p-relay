import { EventEmitter } from 'events';
import logger from '../logger.js';

class TipWatcher extends EventEmitter {
    constructor(electrumClient) {
        super();
        this.electrumClient = electrumClient;
        this.currentTip = null;
    }

    async start() {
        try {
            // Subscribe to header notifications
            await this.electrumClient.request('blockchain.headers.subscribe', []);
            
            // Check if the subscription event handler is correctly set up
            this.electrumClient.subscribe.on('blockchain.headers.subscribe', (params) => {
                // Add debug logging here
                logger.debug("Received blockchain header subscription update", { params });
                this.handleNewTip(params[0]);
            });

            logger.info("TipWatcher: Subscribed to blockchain headers");

            // Get the initial tip
            const initialTip = await this.electrumClient.request('blockchain.headers.subscribe', []);
            logger.debug("Initial tip received", { initialTip });
            this.handleNewTip(initialTip);
        } catch (error) {
            logger.error("TipWatcher: Error during start:", error);
        }
    }

    handleNewTip(tip) {
        if (!this.currentTip || tip.height > this.currentTip.height) {
            this.currentTip = tip;
            logger.info("TipWatcher: New blockchain tip detected", { height: tip.height });
            this.emit('newTip', tip);
        }
    }

    getCurrentTip() {
        return this.currentTip;
    }
}

export default TipWatcher;