import logger from '../logger.js'
import { CID } from 'multiformats/cid'
import { unixfs } from '@helia/unixfs'
import { IPFSAccessController } from '@doichain/orbitdb'

const BASE_RATE_PER_MB_PER_MONTH = 742000; // 0.00742 DOI in swartz (1 DOI = 100,000,000 swartz)
const BLOCKS_PER_YEAR = 525600 // Approximate number of blocks per year
const EXPIRATION_BLOCKS = 36000 // NFT name expiration in blocks
const MIN_FEE = 1000000; // 0.01 DOI in swartz

export class PinningService {
    constructor(helia, orbitdb, electrumClient) {
        this.helia = helia
        this.orbitdb = orbitdb
        this.electrumClient = electrumClient
        this.fs = unixfs(helia)
    }

    /**
     * Calculate fee based on file size and duration
     * @param {number} fileSizeBytes - File size in bytes
     * @param {number} durationMonths - Duration in months
     * @returns {number} - Fee in swartz (1 DOI = 100,000,000 swartz)
     */
    calculatePinningFee(fileSizeBytes, durationMonths) {
        const fileSizeMB = fileSizeBytes / (1024 * 1024);
        const calculatedFee = Math.floor(BASE_RATE_PER_MB_PER_MONTH * durationMonths * fileSizeMB);
        return Math.max(calculatedFee, MIN_FEE);
    }

    /**
     * Get available durations based on NFT expiration
     * @param {number} currentBlock - Current block height
     * @param {number} registrationBlock - Block when NFT was registered
     * @returns {Object} - Available durations in months
     */
    getAvailableDurations(currentBlock, registrationBlock) {
        const remainingBlocks = EXPIRATION_BLOCKS - (currentBlock - registrationBlock)
        const remainingMonths = Math.floor((remainingBlocks / BLOCKS_PER_YEAR) * 12)

        return {
            maxDuration: Math.min(remainingMonths, 12),
            options: [
                { months: 1, label: '1 Month' },
                { months: 6, label: '6 Months' },
                { months: 12, label: '12 Months (1 Year)' }
            ].filter(option => option.months <= remainingMonths)
        }
    }

    /**
     * Validate and process payment for pinning
     * @param {string} paymentTxId - Payment transaction ID
     * @param {number} expectedAmount - Expected payment amount
     * @returns {Promise<boolean>} - Payment validation result
     */
    async validatePayment(paymentTxId, expectedAmount) {
        try {
            const tx = await this.electrumClient.request('blockchain.transaction.get', [paymentTxId, true])
            const totalPaid = tx.vout.reduce((sum, output) => sum + output.value, 0)
            return Math.abs(totalPaid - expectedAmount) < 0.00001 // Allow small rounding differences
        } catch (error) {
            logger.error('Payment validation failed:', error)
            return false
        }
    }

    /**
     * Pin content with expiration tracking
     * @param {string} cid - Content identifier
     * @param {number} durationMonths - Pinning duration in months
     * @param {Object} nameOp - Name operation details
     * @returns {Promise<Object>} - Pinning result
     */
    async pinContent(cid, durationMonths, nameOp) {
        try {
            const paymentStartDate = new Date(process.env.PAYMENT_START_DATE || '2025-01-01');
            const currentDate = new Date();
            const requirePayment = currentDate >= paymentStartDate;

            let totalSize = 0;
            for await (const chunk of this.fs.cat(CID.parse(cid))) {
                totalSize += chunk.length;
            }
            const expectedFee = this.calculatePinningFee(totalSize, durationMonths);
            let paymentAmount = 0;
            if (requirePayment) {
                const RELAY_ADDRESS = process.env.RELAY_PAYMENT_ADDRESS;
                const txDetails = await this.electrumClient.request('blockchain.transaction.get', [nameOp.txid, true]);
                
                const paymentOutput = txDetails.vout.find(output => 
                    output.scriptPubKey?.addresses?.includes(RELAY_ADDRESS) &&
                    output.n !== nameOp.n
                );

                if (!paymentOutput) {
                    throw new Error(`No payment output found in transaction ${nameOp.txid}`);
                }

                paymentAmount = paymentOutput.value;
                if (paymentAmount < expectedFee) {
                    throw new Error(`Insufficient payment: expected ${expectedFee} DOI, got ${paymentAmount} DOI`);
                }

                logger.info(`Valid payment found: ${paymentAmount} DOI in tx ${nameOp.txid}`);
            }

            // Pin the content
            logger.info(`Pinning content: ${cid}`)
            await this.helia.pins.add(CID.parse(cid))

            // Retrieve file information from IPFS
            let fileName = 'unknown';
            for await (const file of this.fs.ls(CID.parse(cid))) {
                if (file.type === 'file') {
                    fileName = file.name;
                    break; // Assuming you want the first file's name
                }
            }

            logger.info(`Detected file name: ${fileName}`);
            logger.info(`nameOp: `,nameOp);
            // Store pinning metadata in OrbitDB with explicit null values instead of undefined
            logger.info(`Storing pinning metadata in OrbitDB for content: ${cid}`)
            const pinningMetadata = {
                _id: cid, // Required for docstore
                cid: cid || null,
                fileName: fileName || null,
                size: totalSize || 0,
                pinDate: Date.now(),
                expirationDate: Date.now() + (durationMonths * 30 * 24 * 60 * 60 * 1000),
                paymentTxId: nameOp.txid || null,
                fee: expectedFee || 0,
                paymentAmount: paymentAmount || 0,
                paymentSufficient: requirePayment?(paymentAmount >= expectedFee):true,
                nameId: nameOp.nameId || null,
                nameTxid: nameOp.txid || null,
                requirePayment: requirePayment || false
            }

            // Open docstore instead of kvstore
            logger.info(`Opening OrbitDB docstore for pinning metadata`)
            try {
                const db = await this.orbitdb.open('pinning-metadata', {
                    type: 'documents',
                    create: true,
                    overwrite: false,
                    AccessController: IPFSAccessController({ write: [this.orbitdb.identity.id] })
                })
                logger.info(`Putting pinning metadata in OrbitDB`)
                await db.put(pinningMetadata)

                logger.info(`Content pinned successfully: ${cid}`, pinningMetadata)
            } finally {
                if (db) {
                    await db.close();
                    logger.info('Database closed successfully');
                }
            }

            return {
                success: true,
                ...pinningMetadata
            }
        } catch (error) {
            logger.error(`Failed to pin content: ${cid}`, error)
            throw error
        }
    }

    /**
     * Check if content should remain pinned
     * @param {string} cid - Content identifier
     * @returns {Promise<boolean>} - Should remain pinned
     */
    async shouldRemainPinned(cid) {
        try {
            const db = await this.orbitdb.open('pinning-metadata', {
                type: 'documents',
                create: true,
                overwrite: false,
                AccessController: IPFSAccessController({ write: [this.orbitdb.identity.id] })
            })
            
            // Query document by cid
            const allDocs = await db.query(doc => doc.cid === cid)
            const metadata = allDocs[0]

            if (!metadata) {
                return false
            }

            return Date.now() < metadata.expirationDate || !metadata.requirePayment || metadata.paymentSufficient
        } catch (error) {
            logger.error(`Error checking pin status for ${cid}:`, error)
            return false
        } finally {
            if (db) {
                await db.close();
                logger.info('Database closed successfully');
            }
        }
    }
} 