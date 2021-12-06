const dgram = require('dgram');
const fs = require('fs');
const uuid = require('uuid');

// reference: https://en.wikipedia.org/wiki/JPEG_File_Interchange_Format#File_format_structure
const beginByte = new Uint8Array([0xFF, 0xD8]); // JFIF SOI: FF D8
const closeByte = new Uint8Array([0xFF, 0xD9]); // JFIF EOI: FF D9

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

class MJpegStream {
	/**
	 * set port to listen local UDP packet
	 * @param {number} port integer
	 */
	constructor(port = 48545) {
		this.port = port;
		this.clients = [];
		this.boundary = 'frame';
		this.streaming = false;
		this.chunkHandler = () => { };

		// serve UDP service
		this.server = this.serveUdp(port);
	}
	destroy(closure) {
		this.server.close(closure);
	}
	serveUdp(port) {
		let udp = dgram.createSocket('udp4');
		udp.on('error', (err) => {
			console.log(`server error:\n${err.stack}`);
			udp.close(() => {
				setTimeout(() => this.server = this.serveUdp(port), 3e3);
			});
		});
		udp.on('listening', () => {
			const address = udp.address();
			console.log(`server listening ${address.address}:${address.port}`);
		});
		udp.on('close', () => {
			for (let i = parseInt(this.clients.length); i--;) {
				// client: [id, response]
				try {
					this.clients[i][1].end();
				} catch (error) { }
			}
		});

		udp.bind(port);
		return udp
	}
	queue(request, response) {
		if (response.socket == null) {
			console.log('response.sock is null');
			return;
		}

		if (this.streaming) {
			this._newClient(request, response);
		} else {
			this.streaming = true;
			this._newClient(request, response);
			let mounted = false;
			let io = [0, 1]; // $[0] to write, $[1] to read
			let buff = [[], []];
			this.chunkHandler = (msg, rinfo) => {
				let chunk = Buffer.from(msg);
				let begin_at = chunk.indexOf(beginByte); // SOI
				let close_at = chunk.indexOf(closeByte); // EOI
				let flag = false; // true to write response

				if (mounted) {
					if (close_at == chunk.length - 2) {
						// close at chunk tail;
						buff[io[0]].push(chunk);
						swap(io);
						flag = true;
					} else if (begin_at == 0) {
						// begin at chunk head;
						buff[io[0]].push(chunk);
					} else if (begin_at - close_at == 2) {
						// Expect: ^ ... FF D9 FF D8  ... $
						// divide old and new content via begin byte
						buff[io[0]].push(chunk.slice(0, begin_at));
						swap(io);
						flag = true;
						buff[io[0]].push(chunk.slice(begin_at));
					} else {
						buff[io[0]].push(chunk);
					}
				} else if (begin_at > -1) {
					buff[io[0]].push(chunk.slice(begin_at));
					mounted = true;
				}

				if (flag) {
					let content = Buffer.concat(buff[io[1]]);
					buff[io[1]] = []; // flush read buffer
					// write response
					// TODO: use queue to control frame stand
					for (let i = parseInt(this.clients.length); i--;) {
						// client: [id, response]
						this.clients[i][1].write(`--${this.boundary}\r\n`);
						this.clients[i][1].write('Content-Type: image/jpeg\r\n');
						this.clients[i][1].write(`Content-Length: ${content.length}\r\n`);
						this.clients[i][1].write('\r\n');
						this.clients[i][1].write(content, 'binary');
						this.clients[i][1].write('\r\n');
					}
				}
			}
			this.server.on('message', this.chunkHandler);
		}
	}
	_newClient(request, response) {
		const id = uuid.v4();
		response.writeHead(200, {
			'Content-Type': `multipart/x-mixed-replace;boundary=${this.boundary}`,
			'Cache-Control': 'no-cache, no-store, must-revalidate',
			'Connection': 'close',
			'Pragma': 'no-cache',
			//'Expires': 'Thu, 01 Jan 1970 00:00:00 GMT', // new Date(0).toGMTString()
		});

		this.clients.push([id, response]);

		response.socket.on('close', () => {
			//console.log(`close ${id}`);
			this.clients.splice(this.clients.findIndex(([_id]) => id === _id), 1);

			if (this.clients.length == 0) {
				//console.log(`destroy listener`);
				this.streaming = false;
				try {
					this.server.removeListener('message', this.chunkHandler);
				} catch (error) {
					fs.writeFile(`./last-stream-error.log`, `${error && error.stack}`, 'utf-8', () => { });
				}
			}
		})
	}
}

module.exports = MJpegStream;