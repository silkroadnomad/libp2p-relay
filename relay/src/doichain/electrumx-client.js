import { EventEmitter } from 'events';

export const makeRequest = (method, params, id) => {
	return JSON.stringify({
		jsonrpc: '2.0',
		method: method,
		params: params,
		id: id,
	});
};

export const createPromiseResult = (resolve, reject) => {
	return (err, result) => {
		if (err) reject(err);
		else resolve(result);
	};
};

export const createPromiseResultBatch = (resolve, reject, argz) => {
	return (err, result) => {
		if (result && result[0] && result[0].id) {
			// this is a batch request response
			for (let r of result) {
				r.param = argz[r.id];
			}
		}
		if (err) reject(err);
		else resolve(result);
	};
};

export class ElectrumxClient {

	constructor(host, port, protocol, options) {
		this.id = 0;
		this.port = port;
		this.host = host;
		this.callback_message_queue = {};
		this.subscribe = new EventEmitter();
		this._protocol = protocol; // saving defaults
		this._options = options;
	}

	getStatus() {
		return this.status;
	}

	async connect() {
		if (this.status === 1) {
			return Promise.resolve();
		}
		this.status = 1;

		if (typeof WebSocket === 'undefined') {
			const wsModule = await import('ws')
			return this.connectSocket(wsModule.WebSocket, this.port, this.host, this._protocol);
		} else {
			return this.connectSocket(WebSocket, this.port, this.host, this._protocol);
		}
	}

	connectSocket(wsModule, port, host, protocol) {
		return new Promise((resolve, reject) => {

			this.ws = new wsModule(`${protocol}://${host}:${port}/`);
			this.ws.onopen = () => {
				console.log(`[ElectrumX] Connected to ${host}:${port}`);
				resolve();
			};

			this.ws.onmessage = (messageEvent) => {
				this.onMessage(messageEvent.data);
			}

			this.ws.onclose = e => {
				console.log(`[ElectrumX] Connection closed: ${e.code ? `Code ${e.code}` : ''} ${e.reason || ''}`);
				this.status = 0;
				this.onClose();
			};

			const errorHandler = e => reject(e);
			this.ws.onerror = err => {
				console.error(
					`[ElectrumX] Connection error: ${err.message || 'Unknown error'}`
				);
				this.status = 0;
				this.ws.close();
				errorHandler();
			};
		});
	}

	close() {
		if (this.status === 0) {
			return;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.status = 0;
	}

	request(method, params) {
		if (this.status === 0) {
			return Promise.reject(new Error('ESOCKET'));
		}
		return new Promise((resolve, reject) => {
			const id = ++this.id;
			const content = makeRequest(method, params, id);
			this.callback_message_queue[id] = createPromiseResult(resolve, reject);
			this.ws.send(content + '\n', 'utf8');
		});
	}

	requestBatch(method, params, secondParam) {
		if (this.status === 0) {
			return Promise.reject(new Error('ESOCKET'));
		}
		return new Promise((resolve, reject) => {
			let arguments_far_calls = {};
			let contents = [];
			for (let param of params) {
				const id = ++this.id;
				if (secondParam !== undefined) {
					contents.push(makeRequest(method, [param, secondParam], id));
				} else {
					contents.push(makeRequest(method, [param], id));
				}
				arguments_far_calls[id] = param;
			}
			const content = '[' + contents.join(',') + ']';
			this.callback_message_queue[this.id] = createPromiseResultBatch(resolve, reject, arguments_far_calls);
			// callback will exist only for max id
			this.ws.send(content + '\n', 'utf8');
		});
	}

	response(msg) {
		let callback;
		if (!msg.id && msg[0] && msg[0].id) {
			// this is a response from batch request
			for (let m of msg) {
				if (m.id && this.callback_message_queue[m.id]) {
					callback = this.callback_message_queue[m.id];
					delete this.callback_message_queue[m.id];
				}
			}
		} else {
			callback = this.callback_message_queue[msg.id];
		}

		if (callback) {
			delete this.callback_message_queue[msg.id];
			if (msg.error) {
				callback(msg.error);
			} else {
				callback(null, msg.result || msg);
			}
		} else {
			console.warn('[ElectrumX] Missing callback for message:', msg.id);
		}
	}

	onMessage(body) {
		const msg = JSON.parse(body);
		if (msg instanceof Array) {
			this.response(msg);
		} else {
			if (msg.id !== 0) {
				this.response(msg);
			} else {
				this.subscribe.emit(msg.method, msg.params);
			}
		}
	}

	onClose(e) {
		this.status = 0;
		Object.keys(this.callback_message_queue).forEach(key => {
			this.callback_message_queue[key](new Error('close connect'));
			delete this.callback_message_queue[key];
		});
	}

}