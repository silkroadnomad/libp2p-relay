import logger from '../logger.js'
import { IPFSAccessController } from '@orbitdb/core'

const FAILED_CIDS_DB = 'failed-cids'
let failedCidsDB = null

// Initialize the failed CIDs database
async function getFailedCidsDB(orbitdb) {
    if (!failedCidsDB) {
        failedCidsDB = await orbitdb.open(FAILED_CIDS_DB, {
            type: 'documents',
            create: true,
            overwrite: false,
            directory: './orbitdb/failed-cids',
            AccessController: IPFSAccessController({ write: ['*'] })
        })
    }
    return failedCidsDB
}

// Function to add a failed CID to OrbitDB
async function addFailedCID(failedCID, orbitdb) {
    try {
        const db = await getFailedCidsDB(orbitdb)
        
        // Get all existing failed CIDs
        const existingDocs = await db.all()
        logger.info("existingDocs", existingDocs)
        const existingCIDs = existingDocs.map(doc => doc.cid)
        console.log("failedCID", failedCID)
        // Only add if it doesn't exist
        if (!existingCIDs.includes(failedCID.cid)) {
            await db.put({
                _id: failedCID.cid, // Use the CID as the document ID
                ...failedCID,
                addedAt: new Date().toISOString()
            })
            
            const totalCIDs = (await db.all()).length
            logger.info(`Added failed CID to database. Total unique CIDs: ${totalCIDs}`)
        }
    } catch (error) {
        logger.error(`Error adding failed CID to database: ${error.message}`)
    }
}

// Function to get all failed CIDs from OrbitDB
async function getFailedCIDs(orbitdb) {
    try {
        const db = await getFailedCidsDB(orbitdb)
        const docs = await db.all()
        return docs.map(doc => ({
            cid: doc.cid,
            type: doc.type,
            nameId: doc.nameId,
            parentCid: doc.parentCid
        }))
    } catch (error) {
        logger.error(`Error getting failed CIDs from database: ${error.message}`)
        return []
    }
}

// Function to remove successful CIDs
async function removeSuccessfulCIDs(successfulCIDs, orbitdb) {
    try {
        const db = await getFailedCidsDB(orbitdb)
        for (const cid of successfulCIDs) {
            await db.del(cid.cid) // Delete using the CID as document ID
        }
        logger.info(`Removed ${successfulCIDs.length} successful CIDs from database`)
    } catch (error) {
        logger.error(`Error removing successful CIDs from database: ${error.message}`)
    }
}

// Function to log failed CIDs
async function logFailedCIDs(orbitdb) {
    const failedCIDs = await getFailedCIDs(orbitdb);
    if (failedCIDs.length > 0) {
        logger.warn(`Failed to pin ${failedCIDs.length} CIDs:`);
        failedCIDs.forEach(({ cid, type, parentCid }) => {
            if (type === 'metadata_processing' || type === 'retrieval_or_pinning') {
                logger.warn(`- Metadata CID: ${cid} (${type})`);
            } else if (type === 'image') {
                logger.warn(`- Image CID: ${cid} (from metadata ${parentCid})`);
            }
        });
    } else {
        logger.info('All CIDs were successfully pinned.');
    }
}

export {
    addFailedCID,
    getFailedCIDs,
    removeSuccessfulCIDs,
    logFailedCIDs
} 