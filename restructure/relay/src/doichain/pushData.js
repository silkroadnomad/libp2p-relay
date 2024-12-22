/**
 * pushData checks length of data and decides formatting of data
 * For details:
 * Oct 6, 2018 • Jeremy Rand
 * - https://www.namecoin.org/2018/10/06/electrum-nmc-name-transaction-creation.html
 * - https://github.com/namecoin/electrum-nmc/blob/master/electrum_nmc/electrum/commands.py#L1430
 * @param data
 * @returns {string} a hex string to be inserted into a op script which can be sent to ElectrumX
 */
export function pushData(data) {
	let buffer = [];
	const len = data.length;

	if (len < 0x4c) {
		buffer.push(len);
	} else if (len <= 0xff) {
		buffer.push(0x4c, len);
	} else if (len <= 0xffff) {
		buffer.push(0x4d, len & 0xff, len >>> 8);
	} else {
		buffer.push(0x4e, len & 0xff, (len >>> 8) & 0xff, (len >>> 16) & 0xff, len >>> 24);
	}

	buffer = Buffer.from(buffer).toString('hex').concat(Buffer.from(data).toString('hex'));
	return buffer;
}