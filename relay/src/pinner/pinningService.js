import logger from '../logger.js'
import { CID } from 'multiformats/cid'
import { unixfs } from '@helia/unixfs'

const BASE_RATE_PER_MB_PER_MONTH = 0.00742 // DOI
const BLOCKS_PER_YEAR = 52560 // Approximate number of blocks per year
const EXPIRATION_BLOCKS = 36000 // NFT name expiration in blocks

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
     * @returns {number} - Fee in DOI
     */
    calculatePinningFee(fileSizeBytes, durationMonths) {
        const fileSizeMB = fileSizeBytes / (1024 * 1024)
        return BASE_RATE_PER_MB_PER_MONTH * durationMonths * fileSizeMB
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
     * @param {string} paymentTxId - Payment transaction ID
     * @returns {Promise<Object>} - Pinning result
     */
    async pinContent(cid, durationMonths, paymentTxId) {
        try {
            // Get content size
            let totalSize = 0
            for await (const chunk of this.fs.cat(CID.parse(cid))) {
                totalSize += chunk.length
            }

            // Calculate expected fee
            const expectedFee = this.calculatePinningFee(totalSize, durationMonths)

            // Validate payment
            const isPaymentValid = await this.validatePayment(paymentTxId, expectedFee)
            if (!isPaymentValid) {
                throw new Error('Invalid payment amount')
            }

            // Pin the content
            await this.helia.pins.add(CID.parse(cid))

            // Store pinning metadata in OrbitDB
            const pinningMetadata = {
                cid,
                size: totalSize,
                pinDate: Date.now(),
                expirationDate: Date.now() + (durationMonths * 30 * 24 * 60 * 60 * 1000),
                paymentTxId,
                fee: expectedFee
            }

            const db = await this.orbitdb.kvstore('pinning-metadata')
            await db.put(cid, pinningMetadata)

            logger.info(`Content pinned successfully: ${cid}`, pinningMetadata)

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
            const db = await this.orbitdb.kvstore('pinning-metadata')
            const metadata = await db.get(cid)

            if (!metadata) {
                return false
            }

            return Date.now() < metadata.expirationDate
        } catch (error) {
            logger.error(`Error checking pin status for ${cid}:`, error)
            return false
        }
    }
} 