import axios from 'axios';

export class DoichainRPC {
    constructor(config = {}) {
        this.config = {
            protocol: config.protocol || 'http',
            host: config.host || '127.0.0.1',
            port: config.port || 8339,
            username: config.username || process.env.DOICHAIN_RPC_USER,
            password: config.password || process.env.DOICHAIN_RPC_PASSWORD,
        };
    }

    async getRawMempool() {
        return this.call('getrawmempool');
    }

    async call(method, params = []) {
        const url = `${this.config.protocol}://${this.config.host}:${this.config.port}`;
        const auth = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');

        const axiosConfig = {
            method: 'post',
            url: url,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`
            },
            data: {
                jsonrpc: '1.0',
                id: Date.now(),
                method: method,
                params: params
            }
        };

        console.log('Axios Configuration:', axiosConfig);

        try {
            const response = await axios(axiosConfig);

            if (response.data.error) {
                throw new Error(response.data.error.message);
            }

            return response.data.result;
        } catch (error) {
            throw new Error(`RPC call failed: ${error.message}`);
        }
    }
}