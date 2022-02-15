const express = require('express');
const { spawn } = require('child_process');
const router = express.Router();
const MJpegStream = require('./MJpegStream');
const { swap, wait, beginByte, closeByte } = require('../utils');

const hash = '7f4d84893536bf7356e8f3bc235bff9f';
const tunnel = parseInt(process.env.EXPRESS_UDP_PORT) || 48545;

let stream = new MJpegStream(tunnel);
let mounted = process.env.EXPRESS_FFMPEG_SKIP ? true : false;
let instance = { kill: () => { }, killed: true, exitCode: 1 };
let config = {
	kernel: 'dshow',
	quality: 2, // 2-31; lower to higher quality
	fps: 24,
	width: 1280,
	height: 960,
	chunk_size: 1024, // udp chunk size
	resource: 'video=USB Video Device',
	resource_format: 'mjpeg',
	output: 'pipe', // pipe|udp
};
let configHash = JSON.stringify(config);

function ffmpeg() {
	// v4l2 -> video4linux2
	return new Promise((resolve, reject) => {
		try {
			let sub;
			let io = [0, 1];
			let buff = [[], []];
			if (process.env.EXPRESS_FFMPEG_PIPE || config.output === 'pipe') {
				sub = spawn('ffmpeg', [
					'-f', config.kernel,
					//'-input_format', config.resource_format,
					'-i', config.resource,
					'-q:v', config.quality,
					'-r', config.fps,
					'-s', `${config.width}x${config.height}`,
					'-f', 'mjpeg',
					'-flush_packets', 1,
					'pipe:1',
				]);
				sub.stdout.on('data', (data) => {
					if (stream.streaming || stream.shotQueue.length > 0) {
						let chunk = Buffer.from(data);
						let begin_at = chunk.indexOf(beginByte); // SOI
						let close_at = chunk.indexOf(closeByte); // EOI

						if (begin_at == 0 && chunk.length - close_at == 2) {
							//console.log(`stdout: JFIF ${chunk.length} (${data.length})`);
							stream.broadcast(chunk);
						} else if (begin_at == 0) {
							buff[io[0]].push(chunk);
						} else if (chunk.length - close_at == 2) {
							buff[io[0]].push(chunk);
							swap(io);
							stream.broadcast(Buffer.concat(buff[io[1]]));
							buff[io[1]] = [];
						} else {
							buff[io[0]].push(chunk);
						}
					}
				});
			} else {
				sub = spawn('ffmpeg', [
					'-f', config.kernel,
					//'-input_format', config.resource_format,
					'-i', config.resource,
					'-q:v', config.quality,
					'-r', config.fps,
					'-s', `${config.width}x${config.height}`,
					'-f', 'mjpeg',
					'-flush_packets', 1,
					`udp://127.0.0.1:${tunnel}?pkt_size=${config.chunk_size}`,
				]);
			}

			sub.stderr.on('data',
				process.env.EXPRESS_FFMPEG_DEBUG
					? (data) => {
						console.log(`stderr: ${data}`);
						if (/Press \[q\] to stop/.test(data)) {
							instance = sub;
							resolve(sub);
						}
					}
					: (data) => {
						if (/Press \[q\] to stop/.test(data)) {
							instance = sub;
							resolve(sub);
						}
					});

			sub.on('close', (code) => {
				reject && reject(`spawn process exit with code: ${code}`);
			});
		} catch (error) {
			reject(error);
		}
	});
}

router.use('/:hash', (request, response, next) => {
	if (request.params.hash === hash) {
		return next();
	} else {
		return response.status(401).send('Unauthorized');
	}
});

router.get('/:hash/clients', (req, res) => {
	res.json({ clients: stream.clients.map(([id, response, frame, request]) => [id, request.headers['x-forwarded-for'] || request.socket.remoteAddress, frame]), request: req.query });
});

router.get('/:hash/stream', (req, res) => {
	if (mounted) {
		stream.queue(req, res);
	} else {
		res.status(503).send('Camera process hang');
	}
});

router.get('/:hash/shot', (req, res) => {
	stream._newShot(req, res);
});

router.get('/:hash/restart', (req, res) => {
	res.status(202).send('Accept');
	try {
		stream.destroy(() => {
			stream = new MJpegStream(tunnel);
		});
	} catch (error) {
		console.error(error)
	}
});

router.get('/:hash/ffmpeg', (req, res) => {
	res.json(instance);
});

router.get('/:hash/ffmpeg/begin', async (req, res) => {
	if (mounted) {
		res.status(200).send('Mounted');
	} else {
		res.status(202).send('Accept');
		try {
			// begin spawn ffmpeg
			await ffmpeg();
			mounted = true;
		} catch (error) {
			console.error(error)
		}
	}
});

router.get('/:hash/ffmpeg/close', async (req, res) => {
	if (mounted) {
		res.status(202).send('Accept');
		try {
			// close spawn ffmpeg
			await (new Promise(resolve => {
				instance.kill(9);
				wait(() => (instance.exitCode != null || instance.killed), resolve);
			}));
			instance = { kill: () => { }, killed: true, exitCode: 1 };
			mounted = false;
		} catch (error) {
			console.error(error)
		}
	} else {
		res.status(200).send('Closed');
	}
});

router.get('/:hash/ffmpeg/config', (req, res) => {
	res.json(config);
});

router.get('/:hash/ffmpeg/restart', async (req, res) => {
	let flag = true;
	let err = '';
	try {
		await (new Promise(resolve => {
			instance.kill(9);
			wait(() => (instance.exitCode != null || instance.killed), resolve);
		}));
		instance = { kill: () => { }, killed: true, exitCode: 1 };
		await ffmpeg();
		mounted = true;
	} catch (error) {
		flag = false;
		err = error.message;
	}

	if (flag) {
		res.status(202).send('Accept');
	} else {
		res.status(422).send(err);
	}
});

router.put('/:hash/ffmpeg/config', async (req, res) => {
	let flag = true;
	let err = { message: 'unknown error occur' };
	try {
		let {
			kernel = config.kernel,
			quality = config.quality,
			fps = config.fps,
			width = config.width,
			height = config.height,
			chunk_size = config.chunk_size,
			resource = config.resource,
			resource_format = config.resource_format,
			output = config.output,
		} = req.body;
		config.kernel = /^dshow|^v4l2/.test(config.kernel) || config.kernel;
		config.quality = Math.floor(quality) || config.quality;
		config.fps = Math.floor(fps) || config.fps;
		config.width = Math.floor(width) || config.width;
		config.height = Math.floor(height) || config.height;
		config.chunk_size = Math.floor(chunk_size) || config.chunk_size;
		config.resource = /^\/dev\/video[0-9]+$/.test(resource) ? resource : config.resource;
		config.resource_format = /^(yuvj422p|mjpeg)$/.test(resource_format) ? resource_format : config.resource_format;
		config.output = /^(pipe|udp)$/.test(output) ? output : config.output;

		let _configHash = JSON.stringify(config);
		if (configHash !== _configHash) {
			configHash = _configHash;
			await (new Promise(resolve => {
				instance.kill(9);
				wait(() => (instance.exitCode != null || instance.killed), resolve);
			}));
			instance = { kill: () => { }, killed: true, exitCode: 1 };
			await ffmpeg();
			mounted = true;
		}
	} catch (error) {
		flag = false;
		err = error.stack || error.message;
	}

	if (flag) {
		res.status(202).send('Accept');
	} else {
		res.status(422).send(err.message)
	}
})

module.exports = router;
