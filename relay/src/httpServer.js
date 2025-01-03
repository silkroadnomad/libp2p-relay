import http from 'http'
import os from 'os'
import url from 'url'
import 'dotenv/config'
import moment from 'moment/moment.js'
import mime from 'mime-types'
import { CID } from 'multiformats/cid'
import { base64 } from 'multiformats/bases/base64'
import { multiaddr } from '@multiformats/multiaddr'
import { unixfs } from '@helia/unixfs'
import { IPFSAccessController } from '@doichain/orbitdb'
import client from 'prom-client'
import logger from './logger.js'
import { getOrCreateDB } from './pinner/nameOpsFileManager.js'
import { getScanningState } from './pinner/scanningStateManager.js'

// Initialize Prometheus metrics
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();  // Collect default metrics

// Create a custom counter metric
const requestCounter = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path']
});

export function createHttpServer(helia, orbitdb, electrumClient, tipWatcher) {
    console.log("createHttpServer")
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
        }  else if (req.method === 'GET' && parsedUrl.pathname === '/duplicate-nameops') {
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
                                            // try {
                                            //     const failedCIDs = await getFailedCIDs(orbitdb)
                                            //     const failedEntry = failedCIDs.find(f => f.cid === cidStr)
                                            //     if (failedEntry) {
                                            //         await failedEntry.db.del(failedEntry.key)
                                            //         console.log(`✅ Removed ${cidStr} from failed pins database`)
                                            //     }
                                            // } catch (cleanupError) {
                                            //     console.log(`⚠️  Failed to remove ${cidStr} from failed pins database: ${cleanupError.message}`)
                                            // }
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
        } else if (req.method === 'GET' && parsedUrl.pathname === '/scan-block') {
            console.log('Scan block request received', parsedUrl);
            const blockHeight = parseInt(parsedUrl.query.height, 10); // Assume height is passed as a query parameter
            const count = parseInt(parsedUrl.query.count, 10) || 1; // Default to 1 if count is not provided

            if (isNaN(blockHeight) || isNaN(count) || count < 1) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Valid block height and count query parameters are required' }));
                return;
            }

            // Set headers for SSE
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });

            for (let i = 0; i < count; i++) {
                const currentHeight = blockHeight + i;
                try {
                    const blockDetails = await processBlockAtHeight(currentHeight, electrumClient);
                    res.write(`data: ${JSON.stringify({ height: currentHeight, ...blockDetails })}\n\n`);
                } catch (error) {
                    res.write(`data: ${JSON.stringify({
                        error: `Failed to retrieve block details for height ${currentHeight}`,
                        message: error.message
                    })}\n\n`);
                    break; // Stop processing further blocks on error
                }
            }

            res.write('event: end\n');
            res.write('data: End of stream\n\n');
            res.end();
        } else if (req.method === 'GET' && parsedUrl.pathname.startsWith('/ipfs/')) {
            console.log('IPFS content request received', parsedUrl);
            const cidStr = parsedUrl.pathname.split('/ipfs/')[1];
            try {
                const cid = CID.parse(cidStr);
                const fs = unixfs(helia);
                const chunks = [];
                
                for await (const chunk of fs.cat(cid)) {
                    chunks.push(chunk);
                }
                
                const content = Buffer.concat(chunks);
                const mimeType = mime.lookup(cidStr) || 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': mimeType });
                res.end(content);
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Failed to retrieve IPFS content',
                    message: error.message
                }));
            }
        } else if (req.method === 'GET' && parsedUrl.pathname === '/blocknotify') {
            try {
                const tip = {
                    height: parseInt(parsedUrl.query.height, 10),
                };

                // if (isNaN(tip.height)) {
                //     throw new Error('Invalid or missing height parameter');
                // }

                tipWatcher.handleNewTip(tip);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'TipWatcher triggered successfully' }));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Failed to trigger TipWatcher',
                    message: error.message
                }));
            }
        } else if (req.method === 'GET' && parsedUrl.pathname === '/help') {
            const endpoints = {
                "/status": {
                    method: "GET",
                    description: "Returns the status of the server, including connected peers and memory usage.",
                    parameters: "None"
                },
                "/metrics": {
                    method: "GET",
                    description: "Exposes metrics for Prometheus.",
                    parameters: "None"
                },
                "/pinned-cids": {
                    method: "GET",
                    description: "Lists all pinned CIDs and their content.",
                    parameters: "None"
                },
                "/scan-block": {
                    method: "GET",
                    description: "Scans a specific block for name operations.",
                    parameters: {
                        height: "Block height to scan (required)",
                        count: "Number of blocks to scan (optional, default is 1)"
                    }
                },
                "/ipfs/{cid}": {
                    method: "GET",
                    description: "Retrieves content from IPFS for a given CID.",
                    parameters: {
                        cid: "The CID of the content to retrieve (required)"
                    }
                },
                "/blocknotify": {
                    method: "GET",
                    description: "Triggers the TipWatcher with a new block tip.",
                    parameters: {
                        height: "Block height to trigger (required)"
                    }
                }
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(endpoints, null, 2));
        } else if (req.method === 'GET' && parsedUrl.pathname.startsWith('/pinning-data/')) {
            const nameId = parsedUrl.pathname.split('/pinning-data/')[1];
            try {
                const db = await orbitdb.open('pinning-metadata', {
                    type: 'documents',
                    create: true,
                    overwrite: false,
                    AccessController: IPFSAccessController({ write: [orbitdb.identity.id] })
                });

                const pinningData = await db.query(doc => doc.nameId === nameId);

                if (pinningData.length === 0) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'No pinning data found for the specified nameId' }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(pinningData, null, 2));
                }
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Failed to retrieve pinning data',
                    message: error.message
                }));
            } finally {
                if (db) {
                    await db.close();
                    logger.info('Database closed successfully');
                }
            }
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
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
    nameOpsMap.forEach((ops) => {
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

async function processBlockAtHeight(height, electrumClient) {
    let counter = 0;
    let blockDate;
    let nameOpUtxos = [];

    while (true) {
        try {
            const tx = await electrumClient.request('blockchain.transaction.id_from_pos', [height, counter]);
            const txDetails = await electrumClient.request('blockchain.transaction.get', [tx, true]);
            blockDate = new Date(txDetails.blocktime * 1000); // Convert UNIX timestamp to JavaScript Date object
            logger.info(`Processing block at height ${height}, position ${counter}`, { txid: txDetails.txid.toString('hex') })
            for (const vout of txDetails.vout) {
                const asm = vout.scriptPubKey.asm;
                const asmParts = asm.split(" ");
                if (asmParts[0] === 'OP_10' || asmParts[0] === 'OP_NAME_DOI') {
                    logger.info(`nameOp found: ${vout.scriptPubKey.nameOp.name}`);
                    logger.info(`value: ${vout.scriptPubKey.nameOp.value}`);
                    nameOpUtxos.push({
                        txid: txDetails.txid,
                        blocktime: txDetails.blocktime,
                        formattedBlocktime: moment.unix(txDetails.blocktime).format('YYYY-MM-DD HH:mm:ss'),
                        n: vout.n,
                        value: vout.value,
                        nameId: vout.scriptPubKey.nameOp.name,
                        nameValue: vout.scriptPubKey.nameOp.value,
                        address: vout.scriptPubKey?.addresses[0]
                    });
                }
            }
            counter++;
        } catch (ex) {
            if (ex.message.includes('no tx at position') || ex.message.includes('No such transaction')) {
                break;
            }
            logger.warn(`Warning: Error processing transaction at height ${height}, position ${counter}: ${ex.message}`);
            await new Promise(resolve => setTimeout(resolve, 500));
            counter++;
        }
    }

    return { nameOpUtxos, blockDate };
}       