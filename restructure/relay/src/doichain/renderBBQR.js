import { detectFileType, renderQRImage, splitQRs } from 'bbqr'

/**
 * Generates a bbqr (better bitcoin qr) code
 * @param qrData
 * @returns {Promise<string>}
 */
export const generateQRCode = async (qrData) => {
	if(!qrData) return
	const detected = await detectFileType(qrData) //.then(_detected => {
		// console.log("detected.fileType",detected.fileType);
	const splitResult = splitQRs(detected.raw, detected.fileType, {
		// these are optional - default values are shown
		encoding: 'Z', // Zlib compressed base32 encoding
		minSplit: 1, // minimum number of parts to return
		maxSplit: 1295, // maximum number of parts to return
		minVersion: 5, // minimum QR code version
		maxVersion: 40, // maximum QR code version
	});

	// console.log("splitResult.version",splitResult.version)
	// console.log("splitResult.encoding",splitResult.encoding)
	// console.log("splitResult.parts",splitResult.parts)

	const imgBuffer = await renderQRImage(splitResult.parts, splitResult.version, {
		// optional settings - values here are the defaults
		frameDelay: 250,
		randomizeOrder: false,
	})
	// convert to data URL for display
	const base64String = btoa(String.fromCharCode(...new Uint8Array(imgBuffer)));
	const imgDataUrl = `data:image/png;base64,${base64String}`;
	return imgDataUrl;
}