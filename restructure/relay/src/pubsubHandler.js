import { TextEncoder, TextDecoder } from 'util';
import logger from './logger.js';
import { getLastNameOps } from "./pinner/nameOpsFileManager.js";
import { formatFileSize } from './utils.js';
import moment from 'moment';
import { CID } from 'multiformats/cid'

export function setupPubsub(helia, orbitdb, pinningService, electrumClient, fsHelia, CONTENT_TOPIC) {
    helia.libp2p.services.pubsub.subscribe(CONTENT_TOPIC);

    helia.libp2p.services.pubsub.addEventListener('message', async event => {
        logger.info(`Received pubsub message from ${event.detail.from} on topic ${event.detail.topic}`);
        const topic = event.detail.topic;
        // 'from' value available in event.detail.from if needed later
        const message = new TextDecoder().decode(event.detail.data);
        let messageObject;
        console.log("Received message:", message);
        try {
            messageObject = JSON.parse(message);
        } catch (err) {
            // logger.warn('Failed to parse message as JSON:', err);
        }

        if (messageObject && topic.startsWith(CONTENT_TOPIC)) {
            // console.log("Received message:", messageObject);
            if (messageObject.type == "LIST") {
                console.log("Received LIST request:", messageObject);
                const { dateString, pageSize, from, filter } = messageObject;
                const pageSizeValue = parseInt(pageSize, 10) || 10; // Default to 100 if not specified
                await handleListRequest(dateString, pageSizeValue, from, filter, orbitdb, helia, CONTENT_TOPIC);
            }
        } else {
            if (message.startsWith("NEW-CID")) {
                const cid = message.substring(8);
                logger.info(`Processing new CID request: ${cid}`);
                await processNewCID(cid, fsHelia, pinningService, electrumClient, helia, CONTENT_TOPIC);
            }
        }
    });

    helia.libp2p.services.pubsub.addEventListener('gossipsub:message', (evt) => {
        const { from, topic, data } = evt.detail;
        logger.info(`Outgoing pubsub message to ${from} on topic ${topic}`, { message: new TextDecoder().decode(data) });
    });

    helia.libp2p.addEventListener('connection:error', (evt) => {
        logger.warn(`Connection error: ${evt.detail.error.message}`);
    });
}

async function handleListRequest(dateString, pageSize, from, filter, orbitdb, helia, CONTENT_TOPIC) {
    try {
        let nameOps;
        console.log("Handling LIST request:", { dateString, pageSize, from, filter });

        if (!dateString || dateString === "LAST") {
            nameOps = await getLastNameOps(orbitdb, pageSize, from, filter);
            if (nameOps.length === 0) {
                publishMessage(helia, "LAST_100_CIDS:NONE", CONTENT_TOPIC);
                return;
            }
            publishMessage(helia, JSON.stringify(nameOps), CONTENT_TOPIC);
        } else {
            const date = parseDate(dateString);
            if (!date) {
                publishMessage(helia, "INVALID_DATE_FORMAT", CONTENT_TOPIC);
                return;
            }
            filter = { ...filter, date }; // Add date to the filter object
            nameOps = await getLastNameOps(orbitdb, pageSize, from, filter);
            if (nameOps.length > 0) {
                publishMessage(helia, JSON.stringify(nameOps), CONTENT_TOPIC);
            } else {
                publishMessage(helia, `${dateString}_CIDS:NONE`, CONTENT_TOPIC);
            }
        }
    } catch (error) {
        logger.error('Error fetching NameOps:', error);
        publishMessage(helia, `ERROR:Failed to fetch NameOps: ${error.message}`, CONTENT_TOPIC);
    }
}

function parseDate(dateString) {
    if (dateString === "TODAY") {
        return moment.utc().toDate();
    }
    const date = moment.utc(dateString, 'YYYY-MM-DD').startOf('day').toDate();
    return isNaN(date.getTime()) ? null : date;
}

function publishMessage(helia, message, CONTENT_TOPIC) {
    helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(message));
}

async function processNewCID(cid, fsHelia, pinningService, electrumClient, helia, CONTENT_TOPIC) {
    try {
        // Get metadata content and size
        let metadataContent = '';
        let totalSize = 0;
        let metadataSize = 0;

        logger.info(`Fetching metadata for CID: ${cid}`);
        // Measure metadata size
        for await (const buf of fsHelia.cat(cid)) {
            metadataContent += new TextDecoder().decode(buf);
            metadataSize += buf.length;
        }
        totalSize += metadataSize;
        logger.info(`Metadata size: ${formatFileSize(metadataSize)}`);

        // Parse the metadata
        let metadata;
        try {
            // First, check if the content looks like JSON
            const isTextContent = /^[\s{[]/.test(metadataContent.trim());

            logger.debug(`Content type check - appears to be ${isTextContent ? 'text/JSON' : 'binary'}`);
            logger.debug('Content preview:', metadataContent.substring(0, 100));

            if (isTextContent) {
                try {
                    metadata = JSON.parse(metadataContent);
                    logger.debug('Successfully parsed as JSON metadata:', metadata);
                } catch (err) {
                    logger.debug('Content is text but not valid JSON, treating as raw text:', err);
                    metadata = {
                        type: 'text',
                        content: metadataContent
                    };
                }
            } else {
                logger.debug('Content appears to be binary, treating as raw data');
                metadata = {
                    type: 'binary',
                    size: metadataSize
                };
            }
        } catch (e) {
            logger.error(`Failed to process content for CID ${cid}:`, e);
            logger.debug('Content type detection failed. First 100 bytes:', metadataContent.substring(0, 100));
            throw new Error(`Failed to process content for CID: ${cid}`);
        }

        // If metadata contains image, measure its size too
        let imageSize = 0;
        if (metadata.image && metadata.image.startsWith('ipfs://')) {
            const imageCid = metadata.image.replace('ipfs://', '');
            
            // Validate the CID format
            try {
                CID.parse(imageCid); // Ensure the CID is valid
            } catch (cidError) {
                logger.error(`Invalid CID format for image: ${imageCid}`, cidError);
                throw new Error(`Invalid CID format for image: ${imageCid}`);
            }

            logger.info(`Found image in metadata, fetching size for CID: ${imageCid}`);
            try {
                for await (const chunk of fsHelia.cat(imageCid)) {
                    imageSize += chunk.length;
                }
                totalSize += imageSize;
                logger.info(`Image size: ${formatFileSize(imageSize)}`);
            } catch (error) {
                logger.error(`Failed to measure image size for CID: ${imageCid}`, error);
                throw new Error(`Failed to access image: ${imageCid}`);
            }
        } else {
            logger.info('No image found in metadata');
        }

        // Calculate fee based on total size
        logger.info('Fetching current block height for fee calculation');
        const currentBlock = await electrumClient.request('blockchain.headers.subscribe');
        logger.debug('Current block:', currentBlock);

        const durations = pinningService.getAvailableDurations(currentBlock.height, currentBlock.height);
        const durationMonths = durations.maxDuration;
        logger.debug(`Available durations:`, durations);

        const expectedFee = pinningService.calculatePinningFee(totalSize, durationMonths);
        logger.info(`Calculated fee: ${expectedFee} for ${durationMonths} months`);

        // Prepare size information
        const sizeInfo = {
            metadata: formatFileSize(metadataSize),
            image: formatFileSize(imageSize),
            total: formatFileSize(totalSize)
        };
        logger.debug('Size information:', sizeInfo);

        // Create response message with fee information
        const addingMsg = JSON.stringify({
            status: "ADDING-CID",
            cid: cid,
            sizes: sizeInfo,
            fee: {
                amount: expectedFee,
                durationMonths: durationMonths,
                paymentAddress: process.env.RELAY_PAYMENT_ADDRESS
            }
        });

        logger.info(`Publishing response for CID ${cid}`);
        logger.info("Response payload:", addingMsg);
        helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(addingMsg));

    } catch (error) {
        logger.error('Error processing file or sending notification:', error);
    }

    const addedMsg = JSON.stringify({
        status: "ADDED-CID",
        cid: cid,
        // timestamp: Date.now()
    });
    logger.info(`Publishing completion message for CID ${cid}:`, addedMsg);
    helia.libp2p.services.pubsub.publish(CONTENT_TOPIC, new TextEncoder().encode(addedMsg));
}
