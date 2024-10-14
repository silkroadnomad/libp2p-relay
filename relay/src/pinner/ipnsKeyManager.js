import fs from 'fs/promises'
import path from 'path'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'

const KEYS_DIRECTORY = path.join(process.cwd(), 'ipns-keys')

async function ensureKeysDirectory() {
    try {
        await fs.mkdir(KEYS_DIRECTORY, { recursive: true })
    } catch (error) {
        console.error('Error creating keys directory:', error)
    }
}

async function loadKey(keyName) {
    try {
        const keyPath = path.join(KEYS_DIRECTORY, `${keyName}.json`)
        const keyData = await fs.readFile(keyPath, 'utf8')
        
        let parsedData
        try {
            parsedData = JSON.parse(keyData)
        } catch (parseError) {
            // If parsing fails, assume it's a raw base64 string
            parsedData = { raw: keyData.trim() }
        }

        if (!parsedData.raw) {
            throw new Error('Invalid key format: missing raw data')
        }

        const rawKey = uint8ArrayFromString(parsedData.raw, 'base64pad')
        return await generateKeyPair('Ed25519', rawKey)
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error(`Error loading key ${keyName}:`, error)
        }
        return null
    }
}

async function saveKey(name, key) {
    const keyPath = path.join(KEYS_DIRECTORY, `${name}.json`);
    try {
        await fs.writeFile(keyPath, uint8ArrayToString(key.raw, 'base64pad'));
        console.log(`Key ${name} saved successfully`);
    } catch (error) {
        console.error(`Error saving key ${name}:`, error);
        throw error;
    }
}

export async function getOrGenerateKey(keyName) {
    await ensureKeysDirectory()
    let keyPair = await loadKey(keyName)
    if (!keyPair) {
        keyPair = await generateKeyPair('Ed25519')
        await saveKey(keyName, keyPair)
    }
    return keyPair
}
