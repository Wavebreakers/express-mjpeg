/**
 * Property swapper
 * @param {Object} arr
 * @param {*} i
 * @param {*} j
 * @returns
 */
function swap(arr, i = 0, j = 1) {
	let t = arr[i];
	arr[i] = arr[j];
	arr[j] = t;
	return arr;
}

function wait(waitFor, callback, period = 100, countdown = 150) {
	if (countdown === 0) return;
	setTimeout(() => {
		if (waitFor()) {
			callback()
		} else {
			wait(waitFor, callback, period, countdown - 1);
		}
	}, period);
}

// reference: https://en.wikipedia.org/wiki/JPEG_File_Interchange_Format#File_format_structure
const beginByte = new Uint8Array([0xFF, 0xD8]); // JFIF SOI: FF D8
const closeByte = new Uint8Array([0xFF, 0xD9]); // JFIF EOI: FF D9

module.exports = { swap, wait, beginByte, closeByte };