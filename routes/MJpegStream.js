const dgram = require('dgram');
const uuid = require('uuid');
const { swap, beginByte, closeByte } = require('../utils');

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

		this.lastShot = [null];

		// serve UDP service
		this.server = this.serveUdp(port);
	}
	destroy(closure) {
		this.server.close(closure);
	}
	serveUdp(port) {
		let udp = dgram.createSocket('udp4');
		let mounted = false;
		let io = [0, 1];
		let buff = [[], []];
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
		udp.on('message', (msg, rinfo) => {
			if (this.streaming) {
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
					buff[io[1]].length = 0;
					this.broadcast(content);
				}
			}
		});

		udp.bind(port);
		return udp
	}
	async broadcast(content) {
		this.lastShot[0] = content;
		for (let i = parseInt(this.clients.length); i--;) {
			this.clients[i][1].write(`--${this.boundary}\r\n`);
			this.clients[i][1].write('Content-Type: image/jpeg\r\n');
			this.clients[i][1].write(`Content-Length: ${content.length}\r\n`);
			this.clients[i][1].write('\r\n');
			this.clients[i][1].write(content, 'binary');
			this.clients[i][1].write('\r\n');
			if (this.clients[i][2] == -1) {
				continue;
			} else if ((this.clients[i][2] += 1) > 120) {
				this.clients[i][1].end();
			}
		}
	}
	queue(request, response) {
		if (response.socket == null) {
			console.log('response.socket is null');
			return;
		}

		if (this.streaming) {
			this._newClient(request, response);
		} else {
			this.streaming = true;
			this._newClient(request, response);
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
		if (request.query.upgrade) {
			this.clients.push([id, response, -1, request]);
		} else {
			this.clients.push([id, response, 0, request]);
		}

		response.socket.on('close', () => {
			this.clients.splice(this.clients.findIndex(([_id]) => id === _id), 1);

			if (this.clients.length == 0) {
				this.streaming = false;
			}
		})
	}
}

module.exports = MJpegStream;