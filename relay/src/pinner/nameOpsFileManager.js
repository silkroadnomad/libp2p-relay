import { IPFSAccessController } from '@orbitdb/core'
import logger from '../logger.js'

let db = null

/**
 * Initialize or get the single OrbitDB instance
 */
export async function getOrCreateDB(orbitdb) {
    // If we already have the DB open, return it
    if (db) {
        return db
    }

    // Open new DB
    const dbName = 'nameops'
    db = await orbitdb.open(dbName, {
        type: 'documents',
        create: true,
        overwrite: false,
        directory: './orbitdb/nameops',
        AccessController: IPFSAccessController({ write: [orbitdb.identity.id] })
        // AccessController: IPFSAccessController({ write: ['*'] })
    })

    logger.info(`Opened OrbitDB: ${dbName}`)
    return db
}

/**
 * Updates the name operations in OrbitDB.
 */
export async function updateDailyNameOpsFile(orbitdb, nameOpUtxos, blockDate, blockHeight) {
    logger.info("updateDailyNameOpsFile", nameOpUtxos.length, blockDate, blockHeight)
    
    try {
        const db = await getOrCreateDB(orbitdb)
        const docId = `nameops-${blockDate}`
        
        const existingDoc = await db.get(docId)

        const existingNameOps = existingDoc?.value?.nameOps || []
        logger.info("existingNameOps", existingNameOps)

        const allNameOps = [...existingNameOps, ...nameOpUtxos]
        
        // Create a map using a composite key of relevant fields
        const uniqueMap = new Map()
        allNameOps.forEach(nameOp => {
            const key = `${nameOp.nameId}-${nameOp.nameValue}`
            // Keep the most recent operation (highest blocktime)
            if (!uniqueMap.has(key) || uniqueMap.get(key).blocktime < nameOp.blocktime) {
                uniqueMap.set(key, nameOp)
            }
        })
        
        const uniqueNameOps = Array.from(uniqueMap.values())

        await db.put({
            _id: docId,
            nameOps: uniqueNameOps,
            blockHeight,
            blockDate
        })

        logger.info(`Document updated in OrbitDB: ${docId}`,uniqueNameOps)
        return docId

    } catch (error) {
        logger.error(`Error updating OrbitDB: ${error.message}`)
        throw error
    }
}

export async function getLastNameOps(orbitdb, limit = 100) {
    try {
        const db = await getOrCreateDB(orbitdb)
        const allDocs = await db.all()
        
        // Sort documents by date (newest first)
        const sortedDocs = allDocs.sort((a, b) => b.value.blockDate.localeCompare(a.value.blockDate))
        
        // Collect nameOps until we reach the limit
        let nameOps = []
        for (const doc of sortedDocs) {
            nameOps = [...nameOps, ...doc.value.nameOps]
            if (nameOps.length >= limit) {
                nameOps = nameOps.slice(0, limit)
                break
            }
        }

        return nameOps

    } catch (error) {
        logger.error(`Error getting nameOps from OrbitDB: ${error.message}`)
        throw error
    }
}
