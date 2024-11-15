import http from 'http'
import url from 'url'
import { getFailedCIDs } from './pinner/failedCidsManager.js'
import { CID } from 'multiformats/cid'
import { base64 } from "multiformats/bases/base64"
import { unixfs } from "@helia/unixfs"
import { getOrCreateDB } from './pinner/nameOpsFileManager.js'
import { getScanningState } from './pinner/scanningStateManager.js'
import os from 'os'
import 'dotenv/config'
import { multiaddr } from '@multiformats/multiaddr'
import client from 'prom-client'

// Initialize Prometheus metrics
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();  // Collect default metrics

// Create a custom counter metric
const requestCounter = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path']
});

export function createHttpServer(helia, orbitdb) {
    const server = http.createServer(async (req, res) => {
        const parsedUrl = url.parse(req.url, true);

        // Increment the request counter
        requestCounter.inc({ method: req.method, path: parsedUrl.pathname });

        if (req.method === 'GET' && parsedUrl.pathname === '/status') {
            await handleStatusRequest(req, res, helia, orbitdb);
        } else if (req.method === 'GET' && parsedUrl.pathname === '/metrics') {
            // Expose metrics for Prometheus
            res.writeHead(200, { 'Content-Type': client.register.contentType });
            res.end(await client.register.metrics());
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
        } else if (req.method === 'GET' && parsedUrl.pathname === '/check-missing') {
            try {
                const db = await getOrCreateDB(orbitdb)
                console.log(`Checking missing CIDs for database: ${db.address}`)
                const allDocs = await db.all()
                const missingItems = []
                
                // Go through all documents and their nameOps
                for (const doc of allDocs) {
                    console.log(`Checking document`,doc)
                    const nameOps = doc.value.nameOps || []
                    for (const nameOp of nameOps) {
                        // Check if nameValue is an IPFS URL
                        if (typeof nameOp.nameValue === 'string' && nameOp.nameValue.startsWith('ipfs://')) {
                            const cidStr = nameOp.nameValue.replace('ipfs://', '')
                            console.log(`Checking IPFS URL for nameId ${nameOp.nameId}: ${nameOp.nameValue}`)
                            
                            try {
                                const cid = CID.parse(cidStr)
                                console.log(`Valid CID parsed: ${cid.toString()}`)
                                
                                // Check if CID exists in blockstore
                                let existsInBlockstore = false
                                try {
                                    // Add timeout of 5 seconds for blockstore check
                                    const timeoutPromise = new Promise((_, reject) => {
                                        setTimeout(() => reject(new Error('Timeout')), 5000)
                                    })
                                    
                                    await Promise.race([
                                        helia.blockstore.get(cid),
                                        timeoutPromise
                                    ])
                                    existsInBlockstore = true
                                    console.log(`✅ CID exists in blockstore: ${cid.toString()}`)
                                } catch (error) {
                                    existsInBlockstore = false
                                    console.log(`❌ CID not found in blockstore: ${cid.toString()} - ${error.message === 'Timeout' ? 'Check timed out' : 'Not found'}`)
                                }
                                
                                // Check if CID is pinned
                                let isPinned = false
                                console.log(`Checking if CID is pinned: ${cid.toString()}`)
                                for await (const pin of helia.pins.ls()) {
                                    if (pin.cid.toString() === cid.toString()) {
                                        isPinned = true
                                        console.log(`✅ CID is pinned: ${cid.toString()}`)
                                        break
                                    }
                                }
                                if (!isPinned) {
                                    console.log(`❌ CID is not pinned: ${cid.toString()}`)
                                }
                                
                                if (!existsInBlockstore) {
                                    console.log(`⚠️  Adding to missing items: ${nameOp.nameValue} (blockstore: ${existsInBlockstore}, pinned: ${isPinned})`)
                                    missingItems.push({
                                        nameId: nameOp.nameId,
                                        nameValue: nameOp.nameValue,
                                        cid: cidStr,
                                        existsInBlockstore,
                                        isPinned,
                                        blocktime: nameOp.blocktime
                                    })
                                }
                            } catch (cidError) {
                                console.log(`❌ Invalid CID format: ${cidStr} - ${cidError.message}`)
                                missingItems.push({
                                    nameId: nameOp.nameId,
                                    nameValue: nameOp.nameValue,
                                    error: `Invalid CID: ${cidError.message}`,
                                    blocktime: nameOp.blocktime
                                })
                            }
                        }
                    }
                }
                
                // Sort by blocktime descending (newest first)
                missingItems.sort((a, b) => b.blocktime - a.blocktime)
                
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    totalChecked: allDocs.reduce((sum, doc) => sum + (doc.value.nameOps?.length || 0), 0),
                    missingCount: missingItems.length,
                    missing: missingItems
                }, null, 2))
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'Failed to check missing CIDs',
                    message: error.message
                }))
            }
        } else if (req.method === 'GET' && parsedUrl.pathname === '/find-missing') {
            try {
                // Connect to public relay in dev mode
                const relayDevMode = process.env.RELAY_DEV_MODE === 'true'
                console.log("🔌 Connecting to public relay...",relayDevMode)
                if (relayDevMode) {
                    const publicRelayMultiaddrs = [
                        '/dns4/istanbul.le-space.de/tcp/1235/p2p/12D3KooWJhsHWfHAapEs8SUeCq71qvxcT58Qca8VtnYSqSaYvuAH',
                        '/dns4/istanbul.le-space.de/tcp/443/wss/p2p/12D3KooWJhsHWfHAapEs8SUeCq71qvxcT58Qca8VtnYSqSaYvuAH'
                    ]
                    
                    console.log('🔌 Development mode: Connecting to public relay...')
                    for (const addr of publicRelayMultiaddrs) {
                        try {
                            const ma = multiaddr(addr)
                            await helia.libp2p.dial(ma)
                            console.log(`✅ Successfully connected to relay: ${addr}`)
                        } catch (error) {
                            console.log(`❌ Failed to connect to relay: ${addr} - ${error.message}`)
                        }
                    }
                }

                const db = await getOrCreateDB(orbitdb)
                const allDocs = await db.all()
                const missingItems = []
                const fs = unixfs(helia)
                
                // Go through all documents and their nameOps
                for (const doc of allDocs) {
                    const nameOps = doc.value.nameOps || []
                    for (const nameOp of nameOps) {
                        // Check if nameValue is an IPFS URL
                        if (typeof nameOp.nameValue === 'string' && nameOp.nameValue.startsWith('ipfs://')) {
                            const cidStr = nameOp.nameValue.replace('ipfs://', '')
                            console.log(`Checking IPFS URL for nameId ${nameOp.nameId}: ${nameOp.nameValue}`)
                            
                            try {
                                const cid = CID.parse(cidStr)
                                console.log(`Valid CID parsed: ${cid.toString()}`)
                                
                                // Check if CID exists in blockstore
                                let existsInBlockstore = false
                                try {
                                    const timeoutPromise = new Promise((_, reject) => {
                                        setTimeout(() => reject(new Error('Timeout')), 5000)
                                    })
                                    
                                    await Promise.race([
                                        helia.blockstore.get(cid),
                                        timeoutPromise
                                    ])
                                    existsInBlockstore = true
                                    console.log(`✅ CID exists in blockstore: ${cid.toString()}`)
                                } catch (error) {
                                    existsInBlockstore = false
                                    console.log(`❌ CID not found in blockstore: ${cid.toString()} - ${error.message === 'Timeout' ? 'Check timed out' : 'Not found'}`)
                                }
                                
                                // Check if CID is pinned
                                let isPinned = false
                                console.log(`Checking if CID is pinned: ${cid.toString()}`)
                                for await (const pin of helia.pins.ls()) {
                                    if (pin.cid.toString() === cid.toString()) {
                                        isPinned = true
                                        console.log(`✅ CID is pinned: ${cid.toString()}`)
                                        break
                                    }
                                }
                                if (!isPinned) {
                                    console.log(`❌ CID is not pinned: ${cid.toString()}`)
                                }
                                
                                if (!existsInBlockstore) {
                                    console.log(`⚠️  CID missing locally, attempting to retrieve from IPFS: ${cid.toString()} (blockstore: ${existsInBlockstore}, pinned: ${isPinned})`)
                                    
                                    try {
                                        // Add timeout for IPFS retrieval
                                        const timeoutPromise = new Promise((_, reject) => {
                                            setTimeout(() => reject(new Error('Timeout')), 30000) // 30 second timeout for IPFS retrieval
                                        })

                                        // Try to retrieve the content
                                        const chunks = []
                                        const catPromise = (async () => {
                                            for await (const chunk of fs.cat(cid)) {
                                                chunks.push(chunk)
                                            }
                                        })()

                                        await Promise.race([catPromise, timeoutPromise])
                                        const content = new TextDecoder().decode(Buffer.concat(chunks))
                                        console.log(`✅ Successfully retrieved content for CID: ${cid.toString()}`)

                                        // Try to pin it
                                        try {
                                            await helia.pins.add(cid)
                                            console.log(`✅ Successfully pinned CID: ${cid.toString()}`)
                                            isPinned = true
                                            
                                            // Remove from failed pins DB since we successfully retrieved and pinned it
                                            try {
                                                const failedCIDs = await getFailedCIDs(orbitdb)
                                                const failedEntry = failedCIDs.find(f => f.cid === cidStr)
                                                if (failedEntry) {
                                                    await failedEntry.db.del(failedEntry.key)
                                                    console.log(`✅ Removed ${cidStr} from failed pins database`)
                                                }
                                            } catch (cleanupError) {
                                                console.log(`⚠️  Failed to remove ${cidStr} from failed pins database: ${cleanupError.message}`)
                                            }
                                        } catch (pinError) {
                                            console.log(`❌ Failed to pin CID: ${cid.toString()} - ${pinError.message}`)
                                        }

                                        missingItems.push({
                                            nameId: nameOp.nameId,
                                            nameValue: nameOp.nameValue,
                                            cid: cidStr,
                                            existsInBlockstore,
                                            isPinned,
                                            retrievalStatus: 'success',
                                            contentPreview: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
                                            blocktime: nameOp.blocktime
                                        })
                                    } catch (retrievalError) {
                                        console.log(`❌ Failed to retrieve CID: ${cid.toString()} - ${retrievalError.message}`)
                                        missingItems.push({
                                            nameId: nameOp.nameId,
                                            nameValue: nameOp.nameValue,
                                            cid: cidStr,
                                            existsInBlockstore,
                                            isPinned,
                                            retrievalStatus: 'failed',
                                            retrievalError: retrievalError.message,
                                            blocktime: nameOp.blocktime
                                        })
                                    }
                                }
                            } catch (cidError) {
                                console.log(`❌ Invalid CID format: ${cidStr} - ${cidError.message}`)
                                missingItems.push({
                                    nameId: nameOp.nameId,
                                    nameValue: nameOp.nameValue,
                                    error: `Invalid CID: ${cidError.message}`,
                                    blocktime: nameOp.blocktime
                                })
                            }
                        }
                    }
                }
                
                // Sort by blocktime descending (newest first)
                missingItems.sort((a, b) => b.blocktime - a.blocktime)
                
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    totalChecked: allDocs.reduce((sum, doc) => sum + (doc.value.nameOps?.length || 0), 0),
                    missingCount: missingItems.length,
                    missing: missingItems
                }, null, 2))
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({
                    error: 'Failed to check and retrieve missing CIDs',
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
async function handleStatusRequest(req, res, helia, orbitdb) {
    const connectedPeers = helia.libp2p.getPeers();
    const nameOpCount = await getNameOpCount(orbitdb);
    const heliaStats = await getHeliaStats(helia);

    // Get memory information
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const processMemory = process.memoryUsage();

    const peerDetails = await Promise.all(connectedPeers.map(async (peerId) => {
        const connections = helia.libp2p.getConnections(peerId);
        return connections.map(connection => ({
            peerId: peerId.toString(),
            address: connection.remoteAddr.toString(),
            direction: connection.direction,
            status: connection.status,
        }));
    }));

    const flatPeerDetails = peerDetails.flat();
    const scanningState = await getScanningState(orbitdb);
    res.writeHead(200, { 'Content-Type': 'application/json' });
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
        // metrics: {
        //     // peers: helia.libp2p.metrics?.getPeerMetrics(),
        //     // protocol: helia.libp2p.metrics?.getProtocolMetrics(),
        //     // system: helia.libp2p.metrics?.getSystemMetrics()
        // }
    }, null, 2));
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