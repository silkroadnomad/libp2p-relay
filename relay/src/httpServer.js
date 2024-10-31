import http from 'http'
import url from 'url'
import fs from 'fs/promises'

async function getNameOpCount() {
    const nameOpDir = './data/nameops_cids' 
    try {
        const files = await fs.readdir(nameOpDir)
        return files.filter(file => file.endsWith('.json')).length
    } catch (error) {
        console.error('Error reading nameOp directory:', error)
        return 0
    }
}

export function createHttpServer(helia) {
    const server = http.createServer(async (req, res) => {
        const parsedUrl = url.parse(req.url, true)
        
        if (req.method === 'GET' && parsedUrl.pathname === '/status') {
            const connectedPeers = helia.libp2p.getPeers()
            const nameOpCount = await getNameOpCount()
            
            const peerDetails = await Promise.all(connectedPeers.map(async (peerId) => {
                // ... rest of the peer details code remains the same ...
            }))

            const flatPeerDetails = peerDetails.flat()

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                connectedPeersCount: connectedPeers.length,
                nameOpCount,
                peers: flatPeerDetails
            }, null, 2))
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