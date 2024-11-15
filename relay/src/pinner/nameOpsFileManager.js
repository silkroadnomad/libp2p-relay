import logger from '../logger.js'
import { Level } from 'level'

let db = null

/**
 * Initialize or get the single LevelDB instance
 */
export async function getOrCreateDB() {
    if (db) {
        return db
    }

    // Create a new LevelDB instance
    db = new Level('./leveldb/nameops', {
        valueEncoding: 'json'
    })

    logger.info('Opened LevelDB: nameops')
    return db
}

/**
 * Updates the name operations in LevelDB.
 */
export async function updateDailyNameOpsFile(_, nameOpUtxos, blockDate, blockHeight) {
    try {
        const db = await getOrCreateDB()
        const docId = `nameops-${blockDate}`

        let existingDoc
        try {
            existingDoc = await db.get(docId)
        } catch (error) {
            if (error.code !== 'LEVEL_NOT_FOUND') {
                throw error
            }
            existingDoc = { nameOps: [] }
        }

        const existingNameOps = existingDoc.nameOps || []
        logger.info("existingNameOps", existingNameOps)

        const allNameOps = [...existingNameOps, ...nameOpUtxos]

        // Create a map using a composite key of relevant fields
        const uniqueMap = new Map()
        allNameOps.forEach(nameOp => {
            const key = `${nameOp.nameId}-${nameOp.nameValue}`
            if (!uniqueMap.has(key) || uniqueMap.get(key).blocktime < nameOp.blocktime) {
                uniqueMap.set(key, nameOp)
            }
        })

        const uniqueNameOps = Array.from(uniqueMap.values())

        await db.put(docId, {
            nameOps: uniqueNameOps,
            blockHeight,
            blockDate
        })

        logger.info(`Document updated in LevelDB: ${docId}`, uniqueNameOps)
        return docId

    } catch (error) {
        logger.error(`Error updating LevelDB: ${error.message}`)
        throw error
    }
}

/**
 * Retrieves the last name operations from LevelDB.
 */
export async function getLastNameOps(_, limit = 100) {
    try {
        const db = await getOrCreateDB()
        const allDocs = []

        for await (const [key, value] of db.iterator()) {
            allDocs.push({ key, value })
        }

        const sortedDocs = allDocs.sort((a, b) => b.value.blockDate.localeCompare(a.value.blockDate))

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
        logger.error(`Error getting nameOps from LevelDB: ${error.message}`)
        throw error
    }
}
