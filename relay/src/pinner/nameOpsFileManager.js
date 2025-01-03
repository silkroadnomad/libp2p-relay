import { IPFSAccessController } from '@doichain/orbitdb'
import pkg from 'level';
const { Level } = pkg;
import logger from '../logger.js'
import dotenv from 'dotenv'

dotenv.config()

let db = null
const dbType = process.env.DB_TYPE || 'leveldb' // Default to OrbitDB

class OrbitDBInterface {
    constructor(orbitdb) {
        this.orbitdb = orbitdb
    }

    async open() {
        const dbName = 'nameops'
        this.db = await this.orbitdb.open(dbName, {
            type: 'documents',
            create: true,
            overwrite: false,
            directory: './orbitdb/nameops',
            AccessController: IPFSAccessController({ write: [this.orbitdb.identity.id] })
        })
        logger.info(`Opened OrbitDB: ${dbName}`)
    }

    async put(doc) {
        await this.db.put(doc)
    }

    async all() {
        return await this.db.all()
    }

    async close() {
        await this.db.close()
    }
}

class LevelDBInterface {
    constructor() {
        this.db = new Level('./leveldb/nameops')
    }

    async put(doc) {
        await this.db.put(doc._id, JSON.stringify(doc))
    }

    async all() {
        const allDocs = [];
        // Iterate over all entries in the database
        // You can add conditions like { gt: 'a' } if needed
        for await (const [key, value] of this.db.iterator()) {
            allDocs.push(value); // Directly use value as it's already parsed
        }
        return allDocs;
    }

    close() {
        this.db.close()
    }
}

export async function getOrCreateDB(orbitdb) {
    if (db) {
        return db
    }

    if (dbType === 'orbitdb') {
        db = new OrbitDBInterface(orbitdb)
        await db.open()
    } else if (dbType === 'leveldb') {
        db = new LevelDBInterface()
    }

    return db
}

export async function updateDailyNameOpsFile(orbitdb, nameOpUtxos, blockDate, blockHeight) {
    try {
        const db = await getOrCreateDB(orbitdb)
        for (const nameOp of nameOpUtxos) {
            const docId = nameOp.txid
            await db.put({
                _id: docId,
                nameOp,
                blockHeight,
                blockDate
            })
        }

        console.log(`Stored ${nameOpUtxos.length} name operations in ${dbType}`)
        return nameOpUtxos.length

    } catch (error) {
        logger.error(`Error updating ${dbType}: ${error.message}`)
        throw error
    }
}

export async function getLastNameOps(orbitdb, pageSize, from = 10, filter) {
    try {
        const db = await getOrCreateDB(orbitdb)
        const allDocs = await db.all()
        let nameOps = []

        for (const doc of allDocs) {
            const nameOp = JSON.parse(doc).nameOp
            if (!nameOp) {
                console.warn('nameOp is undefined for doc:', doc._id)
                continue
            }
            const blockDate = nameOp.blockDate;
            const filterType = typeof filter === 'string' ? filter : filter?.type;
            const filterDate = filter?.dateString;

            if (applyFilter(nameOp, filterType) && applyDateFilter(blockDate, filterDate)) {
                nameOps.push(nameOp);
            }
        }

        nameOps.sort((a, b) => b.blocktime - a.blocktime)
        const paginatedNameOps = nameOps.slice(from, from + pageSize)
        return paginatedNameOps

    } catch (error) {
        logger.error(`Error getting nameOps from ${dbType}: ${error.message}`)
        throw error
    }
}

export async function closeDB() {
    if (db) {
        await db.close()
        db = null
        logger.info(`Closed ${dbType} database`)
    }
}

function applyFilter(nameOp, selectedFilter){
   
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
        case 'collections':
            return (nameOp.nameValue && nameOp.nameValue.startsWith('ipfs://'));
        default:
            return true; // No filter applied, include all nameOps
    }
}

// Add new helper function for date filtering
function applyDateFilter(blockDate, filterDate) {
    if (!filterDate) return true; // If no date filter, include all
    
    if (!blockDate || !filterDate) {
        console.log('Missing date parameters:', { blockDate, filterDate });
        return true;
    }

    try {
        // Convert both dates to start of day for comparison
        const blockDateStart = new Date(blockDate).setHours(0, 0, 0, 0);
        const filterDateStart = new Date(filterDate).setHours(0, 0, 0, 0);
        
        console.log('Comparing dates:', {
            blockDate,
            filterDate,
            blockDateStart: new Date(blockDateStart).toISOString(),
            filterDateStart: new Date(filterDateStart).toISOString()
        });
        
        return blockDateStart === filterDateStart;
    } catch (error) {
        console.error('Error comparing dates:', error);
        return true; // Include the record if there's an error parsing dates
    }
}
