import { EventEmitter } from 'events';
import logger from '../logger.js';

class TipWatcher extends EventEmitter {
    constructor(electrumClient) {
        super();
        this.electrumClient = electrumClient;
        this.currentTip = null;
        this.subscriptionInterval = null;
    }

    async start() {
        console.log("TipWatcher: Starting");
        this.restartSubscription();
    }

    restartSubscription() {
        if (this.subscriptionInterval) {
            clearInterval(this.subscriptionInterval);
        }

        const subscribeToBlocks = () => {
            console.log("subscribeToBlocks");
            this.electrumClient.subscribe.on('blockchain.headers.subscribe', (params) => {
                console.log('New block detected:', params);
                this.handleNewTip(params[0]);
            });
        };

        subscribeToBlocks();

        // this.subscriptionInterval = setInterval(() => {
        //     console.log('Restarting subscription...');
        //     this.electrumClient.subscribe.removeAllListeners('blockchain.headers.subscribe');
        //     subscribeToBlocks();
        // }, 10000); // Restart every 10 seconds
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