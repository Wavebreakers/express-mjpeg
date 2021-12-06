const express = require('express');
const { spawn } = require('child_process');
const router = express.Router();
const MJpegStream = require('./MJpegStream');

const hash = '7f4d84893536bf7356e8f3bc235bff9f';
const tunnel = parseInt(process.env.EXPRESS_UDP_PORT) || 48545;

let stream = new MJpegStream(tunnel);
let mounted = false;
let instance = { kill: () => { }, killed: true };
let config = {
	quality: 12, // 2-31; lower to higher quality
	fps: 4,
	width: 640,
	height: 480,
	chunk_size: 1024,
	resource: '/dev/video0',
	resource_format: 'mjpeg',
};
let configHash = JSON.stringify(config);

function wait(waitFor, callback, period = 100) {
	setTimeout(() => {
		if (waitFor()) {
			callback()
		} else {
			wait(waitFor, callback);
		}
	}, period);
}
function ffmpeg() {
	// v412 -> video4linux2
	return new Promise((resolve, reject) => {
		try {
			instance = spawn('ffmpeg', [
				'-f', 'v4l2',
				'-input_format', config.resource_format,
				'-i', config.resource,
				'-q:v', config.quality,
				'-r', config.fps,
				'-s', `${config.width}x${config.height}`,
				'-f', 'mjpeg',
				'-flush_packets', '0',
				`udp://127.0.0.1:${tunnel}?pkt_size=${config.chunk_size}`,
			]);
			if (process.env.EXPRESS_FFMPEG_DEBUG) {
				instance.stdout.on('data', (data) => {
					console.log(`stdout: ${data}`);
				});
				instance.stderr.on('data', (data) => {
					console.log(`stderr: ${data}`);
				});
			}

			instance.on('close', (code) => {
				reject(`spawn process exit with code: ${code}`);
			});
			setTimeout(resolve, 1000);
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

router.get('/:hash/stream', (req, res) => {
	if (mounted) {
		stream.queue(req, res);
	} else {
		res.status(503).send('Camera process hang');
	}
});

router.get('/:hash/restart', (req, res) => {
	res.status(202).send('Accept');
	try {
		stream.destroy(() => {
			stream = new MJpegStream(48545);
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
				instance && instance.kill('SIGINT');
				wait(() => instance.killed, resolve);
			}));
			instance = { kill: () => { }, killed: true };
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

router.put('/:hash/ffmpeg/config', async (req, res) => {
	let flag = true;
	let err = { message: 'unknown error occur' };
	try {
		let {
			quality = 31,
			fps = 4,
			width = 640,
			height = 480,
			chunk_size = 1024,
			resource = '/dev/video0',
			resource_format = 'mjpeg'
		} = req.body;
		config.quality = Math.floor(quality) || config.quality;
		config.fps = Math.floor(fps) || config.fps;
		config.width = Math.floor(width) || config.width;
		config.height = Math.floor(height) || config.height;
		config.chunk_size = Math.floor(chunk_size) || config.chunk_size;
		config.resource = /^\/dev\/video[0-9]+$/.test(resource) ? resource : config.resource;
		config.resource_format = /^(yuvj422p|mjpeg)$/.test(resource_format) ? resource_format : config.resource_format;
		let _configHash = JSON.stringify(config);
		if (configHash !== _configHash) {
			configHash = _configHash;
			await (new Promise(resolve => {
				instance && instance.kill('SIGINT');
				wait(() => instance.killed, resolve);
			}));
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
