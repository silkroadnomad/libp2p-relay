import { IPFSAccessController } from '@orbitdb/core'
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
 * 
 * A discrepancy between the number of documents (allDocs.length) and the number of name operation transactions (nameOps) can occur due to the structure and content of the documents in your database. Here's a breakdown of how this might happen:
 * 1. Multiple NameOps per Document: Each document in allDocs can contain multiple nameOps. If each document has more than one nameOp, the total number of nameOps can exceed the number of documents.
 * 2. Filtering and Aggregation: The getLastNameOps function filters and aggregates nameOps from all documents. If the filter criteria match multiple nameOps within a single document, those will be included in the final count.
Document Structure: The structure of your documents might allow for multiple nameOps entries. For example, if a document is structured like this:
 *    {
     "_id": "nameops-2023-10-01",
     "nameOps": [
       { "nameId": "1", "nameValue": "value1" },
       { "nameId": "2", "nameValue": "value2" }
     ],
     "blockHeight": 123456,
     "blockDate": "2023-10-01"
   }
 * 
 * 
 * @param {*} orbitdb 
 * @param {*} pageSize 
 * @param {*} from 
 * @param {*} filter 
 * @returns 
 */
export async function getLastNameOps(pageSize, from=100, filter) {
    console.log("Getting last nameOps from OrbitDB:", { pageSize, from, filter });
    try {
        const db = await getOrCreateDB()
        const allDocs = []

        for await (const [key, value] of db.iterator()) {
            allDocs.push({ key, value })
        }
        // Apply the filter to the documents
        const filteredDocs = allDocs.filter(doc => {
            return doc.value.nameOps.some(nameOp => {
                return applyFilter(nameOp, filter);
            });
        });
        console.log("filteredDocs", filteredDocs)
        // Collect nameOps from filtered documents
        let nameOps = [];
        for (const doc of filteredDocs) {
            nameOps = nameOps.concat(doc.value.nameOps.filter(nameOp => applyFilter(nameOp, filter)));
        }
        // console.log("nameOps", nameOps);
        // Apply pagination
        const paginatedNameOps = nameOps //.slice(from, from + pageSize);
        //const paginatedNameOps = nameOps.slice(from, from + pageSize);
        console.log("paginatedNameOps", paginatedNameOps);
        return paginatedNameOps;

    } catch (error) {
        logger.error(`Error getting nameOps from OrbitDB: ${error.message}`);
        throw error;
    }
}

function applyFilter(nameOp, selectedFilter) {
    const isNotSpecialPrefix = !nameOp.nameId.startsWith('e/') &&
        !nameOp.nameId.startsWith('pe/') &&
        !nameOp.nameId.startsWith('poe/') &&
        !nameOp.nameId.startsWith('nft/') &&
        !nameOp.nameId.startsWith('bp/');

    switch (selectedFilter) {
        case 'all':
            return true;
        case 'e':
            return nameOp.nameId.startsWith('e/');
        case 'pe':
            return nameOp.nameId.startsWith('pe/') || nameOp.nameId.startsWith('poe/');
        case 'bp':
            return nameOp.nameId.startsWith('bp/');
        case 'names':
            return (!nameOp.nameValue || nameOp.nameValue === ' ') && isNotSpecialPrefix;
        case 'other':
            return nameOp.nameValue && isNotSpecialPrefix;
        default:
            return true; // No filter applied, include all nameOps
    }
}