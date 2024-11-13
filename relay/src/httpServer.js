import http from 'http'
import url from 'url'
import { getFailedCIDs } from './pinner/failedCidsManager.js'
import { CID } from 'multiformats/cid'
import { base64 } from "multiformats/bases/base64"
import { unixfs } from "@helia/unixfs"
import { getOrCreateDB } from './pinner/nameOpsFileManager.js'
import { getScanningState } from './pinner/scanningStateManager.js'
import os from 'os'
import * as CBOR from '@ipld/dag-cbor'

/**
 * Retrieves the total count of unique name operations across all documents in OrbitDB
 * @param {Object} orbitdb - The OrbitDB instance
 * @returns {Promise<number>} The total count of unique name operations, or 0 if there's an error
 */
async function getNameOpCount(orbitdb) {
    try {
        const db = await getOrCreateDB(orbitdb)
        const allDocs = await db.all()
        
        // Sum up all nameOps from each document
        const totalCount = allDocs.reduce((sum, doc) => {
            return sum + (doc.value.nameOps?.length || 0)
        }, 0)
        
        return totalCount
    } catch (error) {
        console.error('Error counting nameOps from OrbitDB:', error)
        return 0
    }
}

/**
 * Gets name operations with their history based on a key strategy
 * @param {Object} db - The OrbitDB instance
 * @param {Function} getKey - Function that returns the key for grouping operations
 * @returns {Object} Object containing duplicates and total count
 */
async function getNameOpsHistory(db, getKey) {
    const allDocs = await db.all()
    const nameOpsMap = new Map()
    const duplicates = []

    // Flatten all nameOps from all documents and track duplicates
    allDocs.forEach(doc => {
        const nameOps = doc.value.nameOps || []
        nameOps.forEach(nameOp => {
            const key = getKey(nameOp)
            if (!nameOpsMap.has(key)) {
                nameOpsMap.set(key, [nameOp])
            } else {
                nameOpsMap.get(key).push(nameOp)
            }
        })
    })

    // Filter and sort entries
    nameOpsMap.forEach((ops, key) => {
        if (ops.length > 1) {
            duplicates.push({
                nameId: ops[0].nameId,
                nameValue: ops[0].nameValue,
                count: ops.length,
                operations: ops.sort((a, b) => b.blocktime - a.blocktime)
            })
        }
    })

    return {
        totalCount: duplicates.length,
        duplicates
    }
}

async function getHeliaStats(helia) {
    
    try {

        let pinnedCount = 0;
        let pinnedBlockSize = 0;
        let totalBlocks = 0;
        let totalSize = 0;

        for await (const pin of helia.pins.ls()) {
            const block = await helia.blockstore.get(pin.cid)
            pinnedBlockSize += block.length
            pinnedCount++
        }

        for await (const block of helia.blockstore.getAll()) {
            totalBlocks++;
            const blockSize = block.block?.length || 0;
            totalSize += blockSize;
        }

        return {
            blocks: {
                total: totalBlocks,
                totalSize: Math.round(totalSize / 1024), // KB
            },
            pins: {
                count: pinnedCount,
                totalSize: Math.round(pinnedBlockSize / 1024), // KB
            },
            unpinnedSize: Math.round((totalSize - pinnedBlockSize) / 1024), // KB
        };
    } catch (error) {
        console.error('Error getting Helia stats:', error);
        return {
            blocks: { total: 0, totalSize: 0 },
            pins: { count: 0, totalSize: 0 },
            unpinnedSize: 0
        };
    }
}

export function createHttpServer(helia, orbitdb) {
    const server = http.createServer(async (req, res) => {
        const parsedUrl = url.parse(req.url, true)
        
        if (req.method === 'GET' && parsedUrl.pathname === '/status') {
            const connectedPeers = helia.libp2p.getPeers()
            const nameOpCount = await getNameOpCount(orbitdb)
            const heliaStats = await getHeliaStats(helia)
            
            // Get memory information
            const totalMemory = os.totalmem()
            const freeMemory = os.freemem()
            const usedMemory = totalMemory - freeMemory
            const processMemory = process.memoryUsage()

            const peerDetails = await Promise.all(connectedPeers.map(async (peerId) => {
                const connections = helia.libp2p.getConnections(peerId)
                return connections.map(connection => ({
                    peerId: peerId.toString(),
                    address: connection.remoteAddr.toString(),
                    direction: connection.direction,
                    status: connection.status,
                }))
            }))

            const flatPeerDetails = peerDetails.flat()
            const scanningState = await getScanningState(orbitdb)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                connectedPeersCount: connectedPeers.length,
                nameOpCount,
                peers: flatPeerDetails,
                scanningState: scanningState?.value || null,
                memory: {
                    total: Math.round(totalMemory / 1024 / 1024),    // MB
                    free: Math.round(freeMemory / 1024 / 1024),      // MB
                    used: Math.round(usedMemory / 1024 / 1024),      // MB
                    process: {
                        heapUsed: Math.round(processMemory.heapUsed / 1024 / 1024),      // MB
                        heapTotal: Math.round(processMemory.heapTotal / 1024 / 1024),      // MB
                        rss: Math.round(processMemory.rss / 1024 / 1024),      // MB
                    }
                },
                storage: heliaStats,
                metrics: {
                    peers: helia.libp2p.metrics?.getPeerMetrics(),
                    protocol: helia.libp2p.metrics?.getProtocolMetrics(),
                    system: helia.libp2p.metrics?.getSystemMetrics()
                }
            }, null, 2))
        } else if (req.method === 'GET' && parsedUrl.pathname === '/failed-cids') {
            try {
                const failedCIDs = await getFailedCIDs(orbitdb)
                
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    count: failedCIDs.length,
                    failedCIDs
                }, null, 2))
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'Failed to retrieve failed CIDs',
                    message: error.message
                }))
            }
        } else if (req.method === 'GET' && parsedUrl.pathname === '/duplicate-nameops') {
            try {
                const db = await getOrCreateDB(orbitdb)
                const result = await getNameOpsHistory(db, 
                    nameOp => `${nameOp.nameId}-${nameOp.nameValue}`
                )
                
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    totalDuplicates: result.totalCount,
                    duplicates: result.duplicates
                }, null, 2))
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'Failed to retrieve duplicate nameOps',
                    message: error.message
                }))
            }
        } else if (req.method === 'GET' && parsedUrl.pathname === '/with-history') {
            try {
                const db = await getOrCreateDB(orbitdb)
                const result = await getNameOpsHistory(db, 
                    nameOp => nameOp.nameId
                )
                
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    totalWithHistory: result.totalCount,
                    nameOpsWithHistory: result.duplicates
                }, null, 2))
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'Failed to retrieve nameOps history',
                    message: error.message
                }))
            }
        } else if (req.method === 'GET' && parsedUrl.pathname === '/pinned-cids') {
            try {
                const pinnedCids = []
                const fs = unixfs(helia)
                
                for await (const cid of helia.pins.ls()) {
                    try {
                        // Get the content
                        const chunks = []
                        for await (const chunk of fs.cat(cid.cid)) {
                            chunks.push(chunk)
                        }
                        const content = new TextDecoder().decode(Buffer.concat(chunks))

                        pinnedCids.push({
                            cid: CID.parse(cid.cid.toString(base64.encoder), base64.decoder).toString(),
                            content: content
                        })
                    } catch (contentError) {
                        // If we can't read the content (e.g., if it's not text), just include the CID
                        pinnedCids.push({
                            cid: CID.parse(cid.cid.toString(base64.encoder), base64.decoder).toString(),
                            content: "Unable to read content: " + contentError.message
                        })
                    }
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    count: pinnedCids.length,
                    pinnedCids
                }, null, 2))
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'Failed to retrieve pinned CIDs',
                    message: error.message
                }))
            }
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Not Found')
        }
    })

    const port = process.env.HTTP_PORT || 3000
    server.listen(port, () => {
        console.log(`HTTP server running on port ${port}`)
    })
} 