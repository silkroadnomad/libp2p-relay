import { IPFSAccessController } from '@doichain/orbitdb'
import logger from '../logger.js'

let db = null

/**
 * Initialize or get the single OrbitDB instance
 */
export async function getOrCreateDB(orbitdb) {
    console.log("getOrCreateDB", orbitdb.id)
    if (db) {
        return db
    }

    // Open new DB with documents type and access control
    const dbName = 'nameops'
    db = await orbitdb.open(dbName, {
        type: 'documents',
        create: true,
        overwrite: false,
        directory: './orbitdb/nameops',
        AccessController: IPFSAccessController({ write: [orbitdb.identity.id] })
    })

    logger.info(`Opened OrbitDB: ${dbName}`)
    return db
}

/**
 * Updates the name operations in OrbitDB.
 */
export async function updateDailyNameOpsFile(orbitdb, nameOpUtxos, blockDate, blockHeight) {
    try {
        const db = await getOrCreateDB(orbitdb)
        // Iterate over each nameOpUtxo and store it individually
        for (const nameOp of nameOpUtxos) {
            const docId = nameOp.txid;  // Use txid as the document ID

            // Store each nameOpUtxo as a separate document
            await db.put({
                _id: docId,
                nameOp,  // Store the entire nameOp object
                blockHeight,
                blockDate
            })
        }

        console.log(`Stored ${nameOpUtxos.length} name operations in OrbitDB`)
        return nameOpUtxos.length

    } catch (error) {
        logger.error(`Error updating OrbitDB: ${error.message}`)
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
export async function getLastNameOps(orbitdb, pageSize, from=10, filter) {
    try {
        const db = await getOrCreateDB(orbitdb)
        const allDocs = await db.all()
        
        let nameOps = []
        for (const doc of allDocs) {
            const nameOp = doc.value.nameOp;
            const blockDate = doc.value.blockDate;
            
            // Add debug logging
            console.log('Processing document:', {
                blockDate,
                filterDate: filter?.date,
                passedFilter: applyFilter(nameOp, filter) && applyDateFilter(blockDate, filter?.date)
            });
            
            if (applyFilter(nameOp, filter) && applyDateFilter(blockDate, filter?.date)) {
                nameOps.push(nameOp);
            }
        }
        // Sort nameOps by blocktime in descending order
        nameOps.sort((a, b) => b.blocktime - a.blocktime)
        
        const paginatedNameOps = nameOps.slice(from, from + pageSize)
        return paginatedNameOps

    } catch (error) {
        logger.error(`Error getting nameOps from OrbitDB: ${error.message}`)
        throw error
    }
}

function applyFilter(nameOp, selectedFilter) {
    const hasNameValue = nameOp.nameValue && nameOp.nameValue !== '' && nameOp.nameValue !== ' ' && nameOp.nameValue !== 'empty';
		
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
            return !hasNameValue && isNotSpecialPrefix;
        case 'nfc':
            return (nameOp.nameValue && nameOp.nameValue.startsWith('ipfs://'));
            // return hasNameValue && isNotSpecialPrefix;
        default:
            return true; // No filter applied, include all nameOps
    }
}

// Add new helper function for date filtering
function applyDateFilter(blockDate, filterDate) {
    if (!filterDate) return true; // If no date filter, include all
    
    // Add debug logging
    console.log('Filtering dates:', {
        originalBlockDate: blockDate,
        originalFilterDate: filterDate
    });
    
    // Convert both dates to start of day for comparison
    const blockDateStart = new Date(blockDate).setHours(0, 0, 0, 0);
    const filterDateStart = new Date(filterDate).setHours(0, 0, 0, 0);
    
    // Add more detailed debug logging
    console.log('Comparing dates:', {
        blockDateStart: new Date(blockDateStart).toISOString(),
        filterDateStart: new Date(filterDateStart).toISOString(),
        areEqual: blockDateStart === filterDateStart
    });
    
    return blockDateStart === filterDateStart;
}

// Add new function to close DB
export async function closeDB() {
    if (db) {
        await db.close()
        db = null
        logger.info('Closed nameops database')
    }
}