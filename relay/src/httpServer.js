import http from 'http'
import url from 'url'
import { getFailedCIDs } from './pinner/failedCidsManager.js'
import { CID } from 'multiformats/cid'
import { base64 } from "multiformats/bases/base64"
import { unixfs } from "@helia/unixfs"
import { getOrCreateDB } from './pinner/nameOpsFileManager.js'
import { getScanningState } from './pinner/scanningStateManager.js'

async function getNameOpCount(orbitdb) {
    try {
        const db = await getOrCreateDB(orbitdb)
        const count = (await db.all()).length
        return count
    } catch (error) {
        console.error('Error counting nameOps from OrbitDB:', error)
        return 0
    }
}

export function createHttpServer(helia, orbitdb) {
    const server = http.createServer(async (req, res) => {
        const parsedUrl = url.parse(req.url, true)
        
        if (req.method === 'GET' && parsedUrl.pathname === '/status') {
            const connectedPeers = helia.libp2p.getPeers()
            const nameOpCount = await getNameOpCount(orbitdb)
            
            const peerDetails = await Promise.all(connectedPeers.map(async (peerId) => {
                const connections = helia.libp2p.getConnections(peerId)
                const scanningState = await getScanningState(orbitdb)
                return connections.map(connection => ({
                    peerId: peerId.toString(),
                    address: connection.remoteAddr.toString(),
                    direction: connection.direction,
                    status: connection.status,
                    scanningState: scanningState?.value || null
                }))
            }))

            const flatPeerDetails = peerDetails.flat()

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                connectedPeersCount: connectedPeers.length,
                nameOpCount,
                peers: flatPeerDetails
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