navigator.getMedia = (
	navigator.getUserMedia ||
	navigator.webkitGetUserMedia ||
	navigator.mozGetUserMedia ||
	navigator.msGetUserMedia
);

window.AudioContext = (
	window.AudioContext ||
	window.webkitAudioContext ||
	window.mozAudioContext ||
	window.msAudioContext
);


var RingBuffer = function () { this.init.apply(this, arguments) };
RingBuffer.prototype = {
	init : function (buffer) {
		this.buffer = buffer;
		this.readIndex = 0;
		this.writeIndex = 0;
		this.length = 0;
		this.maxLength = buffer.length;
	},

	get : function (i) {
		if (i < 0) i += this.length;
		return this.buffer[(this.readIndex + i) % this.maxLength];
	},

	remove : function () {
		var ret = this.buffer[this.readIndex];
		this.readIndex = (this.readIndex + 1) % this.maxLength;
		if (this.length > 0) this.length--;
		return ret;
	},

	put : function (v) {
		var buffer = this.buffer;
		var maxLength = this.maxLength;
		var writeIndex = this.writeIndex;

		for (var i = 0, len = arguments.length; i < len; i++) {
			buffer[writeIndex] = arguments[i];
			writeIndex = (writeIndex + 1) % maxLength;
		}

		this.writeIndex = writeIndex;

		this.length += len;
		var over = this.length - maxLength;
		if (over > 0) {
			this.length = maxLength;
			this.readIndex = (this.readIndex + over) % maxLength;
		}
	}
};

RingBuffer.Fast = function () { this.init.apply(this, arguments) };
RingBuffer.Fast.prototype = {
	init : function (buffer) {
		if (buffer.length & (buffer.length-1)) {
			throw "buffer size must be power of 2";
		}
		this.buffer = buffer;
		this.readIndex = 0;
		this.writeIndex = 0;
		this.length = 0;
		this.maxLength = buffer.length;
		this.mask = this.maxLength - 1;
	},

	get : function (i) {
		if (i < 0) i += this.length;
		return this.buffer[(this.readIndex + i) & this.mask];
	},

	remove : function () {
		var ret = this.buffer[this.readIndex];
		this.readIndex = (this.readIndex + 1) & this.mask;
		if (this.length > 0) this.length--;
		return ret;
	},

	put : function (v) {
		var buffer = this.buffer;
		var mask = this.mask;
		var maxLength = this.maxLength;
		var writeIndex = this.writeIndex;

		for (var i = 0, len = arguments.length; i < len; i++) {
			buffer[writeIndex] = arguments[i];
			writeIndex = (writeIndex + 1) & mask;
		}

		this.writeIndex = writeIndex;

		this.length += len;
		var over = this.length - maxLength;
		if (over > 0) {
			this.length = maxLength;
			this.readIndex = (this.readIndex + over) & mask;
		}
	}
};

RingBuffer.Typed2D = function () { this.init.apply(this, arguments) };
RingBuffer.Typed2D.prototype = {
	init : function (type, unit, length) {
		this.buffer = new type(unit * length);
		this.readIndex = 0;
		this.writeIndex = 0;
		this.unit = unit;
		this.length = 0;
		this.maxLength = length;
	},

	get : function (i) {
		if (i < 0) i += this.length;
		var begin = ((this.readIndex + i) % this.maxLength) * this.unit;
		return this.buffer.subarray(begin, begin + this.unit );
	},

	put : function (v) {
		var buffer = this.buffer;
		var maxLength = this.maxLength;
		var writeIndex = this.writeIndex;
		var unit = this.unit;

		for (var i = 0, len = arguments.length; i < len; i++) {
			buffer.set(arguments[i], writeIndex * unit);
			writeIndex = (writeIndex + 1) % maxLength;
		}
		this.writeIndex = writeIndex;

		this.length += len;
		var over = this.length - maxLength;
		if (over > 0) {
			this.length = maxLength;
			this.readIndex = (this.readIndex + over) % maxLength;
		}
	},

	/**
	 * returns subarray of buffer for writing
	 */
	nextSubarray : function () {
		var begin = this.writeIndex * this.unit;
		var ret = this.buffer.subarray(begin, begin + this.unit);
		if (this.length < this.maxLength) {
			this.length++;
		} else {
			this.readIndex = (this.readIndex + 1) % this.maxLength;
		}
		this.writeIndex = (this.writeIndex + 1) % this.maxLength;
		return ret;
	}
};


var RTTY = {
	BAUDOT_CODE : {
		LTRS : [
			"\0",
			"E",
			"\n",
			"A",
			" ",
			"S",
			"I",
			"U",
			"\r",
			"D",
			"R",
			"J",
			"N",
			"F",
			"C",
			"K",
			"T",
			"Z",
			"L",
			"W",
			"H",
			"Y",
			"P",
			"Q",
			"O",
			"B",
			"G",
			"\x0f", // Shift FIGS
			"M",
			"X",
			"V",
			"\x0e" // Shift LTRS
		],
		FIGS : [ // US BELL
			"\0",
			"3",
			"\n",
			"-",
			" ",
			"\x07",
			"8",
			"7",
			"\r",
			"$",
			"4",
			"'",
			",",
			"!",
			":",
			"(",
			"5",
			'"',
			")",
			"2",
			"#",
			"6",
			"0",
			"1",
			"9",
			"?",
			"&",
			"\x0f",
			".",
			"/",
			";",
			"\x0e"
		]
	},

	init : function () {
		var self = this;
		self.context = new AudioContext();

		self.DOWNSAMPLE_FACTOR = 64;
		self.audioNodes = [];

		self.drawBuffers = {
			bits : new RingBuffer(new Int8Array(Math.pow(2, 11))),
			mark : new RingBuffer(new Float32Array(Math.pow(2, 11))),
			space : new RingBuffer(new Float32Array(Math.pow(2, 11)))
		};

		self.waveFormCanvas = document.getElementById('canvas');
		self.waveFormContext = self.waveFormCanvas.getContext('2d');

		// FFT 結果の4分の1 = 44100 / 2 / 4 = 5512.5Hz までを50個格納
		self.fftResults = new RingBuffer.Typed2D(Uint8Array, 1024 / 4, 50);
		self.waterfallCanvas = document.getElementById('waterfall');
		self.waterfallContext = self.waterfallCanvas.getContext('2d');

		self.fftCanvas = document.getElementById('fft');
		self.fftContext = self.fftCanvas.getContext('2d');

		self.freqMark = 2125;
		self.freqSpace = 2125 + 170;

		self.output = document.getElementById('text');

		self.bindEvents();
	},

	bindEvents : function () {
		var self = this;

		setInterval(function () {
			self.drawWaveForm();
		}, 50);

		setInterval(function () {
			if (self.analyser) {
				self.analyser.getByteFrequencyData(self.fftResults.nextSubarray());
				self.drawWaterFall();
				self.drawFFT();
			}
		}, 50);

		$('#send-form').submit(function () {
			try {
				var input = $(this).find('[name=text]');
				var text = input.val();
				input.val('');
				$('#send-modal').modal('hide');
				self.playAFSK(text, {
					reverse : self.freqSpace > self.freqMark,
					tone : self.freqMark,
					shift : self.freqSpace - self.freqMark,
					baudrate: 45.45
				});
			} catch (e) { alert(e) }
			
			return false;
		});
	},

	retainAudioNode : function (node) {
		var self = this;
		self.audioNodes.push(node);
		return node;
	},

	playAFSK : function (text, opts) {
		var self = this;

		var source = self.context.createBufferSource();
		source.buffer = RTTY.createAFSKBuffer(text, opts);

		var bandpass = self.context.createBiquadFilter();
		bandpass.type = 2;
		bandpass.frequency.value = self.freqMark;
		bandpass.Q.value = 5;

		source.connect(bandpass);
		bandpass.connect(self.context.destination);
		source.start(0);
	},

	decode : function (source) {
		var self = this;
		self.retainAudioNode(source);

		self.analyser = self.context.createAnalyser();
		self.analyser.fftSize = 2048;
		self.analyser.maxDecibels = -10;
		self.analyser.minDecibels = -100;
		source.connect(self.analyser);

		var detection = self._detectCoherent(self.analyser);

		var unit  = Math.round(self.context.sampleRate / self.DOWNSAMPLE_FACTOR / 45.45);
		var current = {
			state : "waiting",
			total : 0,
			mark  : 0,
			space : 0,
			bit   : 0,
			byte  : 0,
			data  : 0,
			set   : RTTY.BAUDOT_CODE.LTRS
		};
		var states = {
			"waiting": function () {
				if (current.data === -1) {
					current.state = "start";
				} else {
					current.total = 0;
				}
			},
			"start": function () {
				if (unit <= current.total) {
					// console.log('start bit');
					current.total = 0;
					current.state = "data";
				}
			},
			"data": function () {
				if (current.data ===  1) current.mark++;
				if (current.data === -1) current.space++;
				if (unit <= current.total) {
					// console.log(current);
					var bit = current.mark > current.space ? 1 : 0;
					current.mark = 0; current.space = 0;
					current.byte = current.byte | (bit<<current.bit++);
					current.total = 0;

					if (current.bit >= 5) {
						current.bit = 0;
						current.state = "stop";
					}
				}
			},
			"stop": function () {
				if (unit <= current.total) {
					// console.log('stop bit');
					var char = current.set[current.byte];
					if (char === "\x0f") {
						current.set = RTTY.BAUDOT_CODE.FIGS;
					} else
					if (char === "\x0e") {
						current.set = RTTY.BAUDOT_CODE.LTRS;
					} else
					if (char === "\r") {
						// skip
					} else {
						// console.log(current.byte.toString(2), current.byte, char);
						self.output.value += char;
						self.output.scrollTop = self.output.scrollHeight;
					}
					current.byte = 0;
					current.state = "waiting";
					current.total = 0;
				}
			}
		};

		var decoder = self.retainAudioNode(self.context.createScriptProcessor(4096, 2, 1));
		decoder.onaudioprocess = function (e) {
			var inputMark  = e.inputBuffer.getChannelData(0);
			var inputSpace = e.inputBuffer.getChannelData(1);
			for (var i = 0, len = e.inputBuffer.length; i < len; i += self.DOWNSAMPLE_FACTOR) { // down sample
				if (inputMark[i] > inputSpace[i]) {
					current.data = inputMark[i] > 0.02 ? 1 : 0;
				} else {
					current.data = inputSpace[i] > 0.02 ? -1 : 0;
				}
				self.drawBuffers.bits.put(current.data);
				self.drawBuffers.mark.put(inputMark[i]);
				self.drawBuffers.space.put(inputSpace[i]);

				states[current.state]();
				current.total++;
			}
		};
		detection.connect(decoder);

		var outputGain = self.retainAudioNode(self.context.createGain());
		outputGain.gain.value = 0;
		decoder.connect(outputGain);
		outputGain.connect(self.context.destination);
	},

	_detectCoherent : function (source) {
		var self = this;

		var toneMark  = self.context.sampleRate / (2 * Math.PI * self.freqMark);
		var toneSpace = self.context.sampleRate / (2 * Math.PI * self.freqSpace);

		var n = 0;
		var iq = self.retainAudioNode(self.context.createScriptProcessor(4096, 1, 4));
		iq.onaudioprocess = function (e) {
			var data = e.inputBuffer.getChannelData(0);
			var outputMarkI  = e.outputBuffer.getChannelData(0);
			var outputMarkQ  = e.outputBuffer.getChannelData(1);
			var outputSpaceI = e.outputBuffer.getChannelData(2);
			var outputSpaceQ = e.outputBuffer.getChannelData(3);
			for (var i = 0, len = e.inputBuffer.length; i < len; i++) {
				outputMarkI[i]  = (Math.sin(n / toneMark)  > 0 ? 1 : -1) * data[i];
				outputMarkQ[i]  = (Math.cos(n / toneMark)  > 0 ? 1 : -1) * data[i];
				outputSpaceI[i] = (Math.sin(n / toneSpace) > 0 ? 1 : -1) * data[i];
				outputSpaceQ[i] = (Math.cos(n / toneSpace) > 0 ? 1 : -1) * data[i];
				n++;
			}
		};
		source.connect(iq);

		var filter = self.retainAudioNode(self.context.createBiquadFilter());
		filter.type = 0; // low pass
		filter.frequency.value = 100;
		filter.Q.value = 0;
		iq.connect(filter);

		var detection = self.retainAudioNode(self.context.createScriptProcessor(4096, 4, 2));
		detection.onaudioprocess = function (e) {
			var inputMarkI  = e.inputBuffer.getChannelData(0);
			var inputMarkQ  = e.inputBuffer.getChannelData(1);
			var inputSpaceI = e.inputBuffer.getChannelData(2);
			var inputSpaceQ = e.inputBuffer.getChannelData(3);

			var outputMark  = e.outputBuffer.getChannelData(0);
			var outputSpace = e.outputBuffer.getChannelData(1);
			for (var i = 0, len = e.inputBuffer.length; i < len; i += self.DOWNSAMPLE_FACTOR) { // down sample
				outputMark[i]  = Math.sqrt(inputMarkI[i]  * inputMarkI[i]  + inputMarkQ[i]  * inputMarkQ[i]);
				outputSpace[i] = Math.sqrt(inputSpaceI[i] * inputSpaceI[i] + inputSpaceQ[i] * inputSpaceQ[i]);
			}
		};
		filter.connect(detection);

		return detection;
	},

	drawWaveForm : function () {
		var self = this;

		var canvas = self.waveFormCanvas;
		var ctx = self.waveFormContext;

		var buffer, n;
		var max = Math.max(
			Math.max.apply(Math, self.drawBuffers.mark.buffer),
			Math.max.apply(Math, self.drawBuffers.space.buffer),
			0.001
		);

		ctx.clearRect(0, 0, canvas.width, canvas.height);

		ctx.beginPath();
		ctx.moveTo(0, canvas.height/2);
		ctx.strokeStyle = "rgba(0, 0, 0, 0.2)";
		buffer = self.drawBuffers.bits;
		for (var i = 0, len = buffer.length; i < len; i++) {
			n = buffer.get(i);
			ctx.lineTo(
				canvas.width * (i / len),
				canvas.height - (n * 0.5 * canvas.height + canvas.height / 2)
			);
		}
		ctx.stroke();

		ctx.beginPath();
		ctx.moveTo(0, canvas.height/2);
		ctx.strokeStyle = "#3276b1";
		buffer = self.drawBuffers.mark;
		for (var i = 0, len = buffer.length; i < len; i++) {
			n = buffer.get(i) / max;
			ctx.lineTo(
				canvas.width * (i / len),
				canvas.height - (n * 0.5 * canvas.height + canvas.height / 2)
			);
		}
		ctx.stroke();

		ctx.beginPath();
		ctx.moveTo(0, canvas.height/2);
		ctx.strokeStyle = "#47a447";
		buffer = self.drawBuffers.space;
		for (var i = 0, len = buffer.length; i < len; i++) {
			n = buffer.get(i) / max;
			ctx.lineTo(
				canvas.width * (i / len),
				canvas.height - (n * 0.5 * canvas.height + canvas.height / 2)
			);
		}
		ctx.stroke();
	},

	drawWaterFall : function () {
		var self = this;
		var canvas = self.waterfallCanvas;
		var ctx = self.waterfallContext;

		var bandwidth = self.context.sampleRate / 2 / self.analyser.frequencyBinCount;
		var mark  = Math.round(self.freqMark / bandwidth);
		var space = Math.round(self.freqSpace / bandwidth);
		var center = Math.round(space < mark ? space + (mark - space) / 2 : mark + (space - mark) / 2);

		var viewBandwidth = 2000;
		var size  = Math.ceil(viewBandwidth / bandwidth);
		var start = Math.round(center - (size / 2));
		var end   = start + size;

		var w = canvas.width, h = canvas.height;
		var imageData = ctx.createImageData(w, h);
		var data      = imageData.data;
		for (var i = 0, len = self.fftResults.length; i < len; i++) {
			var result = self.fftResults.get(i);
			for (var j = 0; j < size; j++) {
//				var dB = 20 * Math.log(result[j]) * Math.LOG10E;
//				var p = (dB / 48.13);
				var p = result[start+j] / 255;

				var r = 0, g = 0, b = 0, a = 255;
				if (j === mark || j === space) {
					r = g = b = 255;
				} else  {
					if (p > 4/5) {
						// yellow -> red
						p = (p - (4/5)) / (1/5);
						r = 255;
						g = 255 * (1 - p);
						b = 0;
					} else
					if (p > 3/5) {
						// green -> yellow
						p = (p - (3/5)) / (1/5);
						r = 255 * p;
						g = 255;
						b = 0;
					} else
					if (p > 2/5) {
						// light blue -> green
						p = (p - (2/5)) / (1/5);
						r = 0;
						g = 255;
						b = 255 * (1 - p);
					} else
					if (p > 1/5) {
						// blue -> light blue
						p = (p - (1/5)) / (1/5);
						r = 0;
						g = 255 * p;
						b = 255;
					} else
					if (p > 0) {
						// black -> blue
						p = p / (1/5);
						r = 0;
						g = 0;
						b = 255 * p;
					}
				}

				var y = i, x = j;
				data[y * w * 4 + x * 4 + 0] = r;
				data[y * w * 4 + x * 4 + 1] = g;
				data[y * w * 4 + x * 4 + 2] = b;
				data[y * w * 4 + x * 4 + 3] = a;
			}
		}
		ctx.putImageData(imageData, 0, 0);
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(
			canvas,
			0, 0, size, self.fftResults.maxLength,
			0, 0, canvas.width, canvas.height
		);
	},

	drawFFT : function () {
		var self = this;
		var canvas = self.fftCanvas;
		var ctx = self.fftContext;

		var bandwidth = self.context.sampleRate / 2 / self.analyser.frequencyBinCount;
		var mark  = Math.round(self.freqMark / bandwidth);
		var space = Math.round(self.freqSpace / bandwidth);
		var center = Math.round(space < mark ? space + (mark - space) / 2 : mark + (space - mark) / 2);

		var viewBandwidth = 2000;
		var size  = Math.ceil(viewBandwidth / bandwidth);
		var start = Math.round(center - (size / 2));
		var end   = start + size;

		var w = canvas.width, h = canvas.height;
		ctx.clearRect(0, 0, w, h);

		var u = w / size;

		var result = self.fftResults.get(-1);
		ctx.beginPath();
		ctx.moveTo(0, h);
		for (var i = 0; i < size; i++) {
			ctx.lineTo(i * u, h - ((result[start+i] / 255) * h) );
		}
		ctx.stroke();
	},

	// self.context 以外に依存しない
	createAFSKBuffer : function (text, opts) {
		var self = this;
		if (!opts) opts = {};
		if (!opts.tone) opts.tone = 2125;
		if (!opts.shift) opts.shift = 170;
		if (!opts.baudrate) opts.baudrate = 45.45;
		if (!opts.reverse) opts.reverse = false;

		var markTone  = self.context.sampleRate / (2 * Math.PI * opts.tone);
		var spaceTone = self.context.sampleRate / (2 * Math.PI * (opts.tone - (opts.reverse ? -opts.shift : opts.shift) ));
		var unit      = self.context.sampleRate / opts.baudrate;
		var wait      = 30;

		text = text.toUpperCase().replace(/[^A-Z \r\n]/g, function (_) {
			return "\x0f" + _ + "\x0e";
		});

		var buffer    = self.context.createBuffer(1, text.length * 7.5 * unit + (wait * 2 * unit), self.context.sampleRate);
		var data      = buffer.getChannelData(0);
		var position  = 0;

		function sendBit (bit, length) {
			var tone = bit ? markTone : spaceTone;
			var len = length * unit;
			for (var i = 0; i < len; i++) {
				data[position++] = Math.sin(position / tone);
			}
		}

		function sendChar (char) {
			sendBit(0, 1); // start bit
			for (var b = 0; b < 5; b++) {
				if (char & (1<<b)) {
					console.log('1');
					sendBit(1, 1);
				} else {
					console.log('0');
					sendBit(0, 1);
				}
			}
			sendBit(1, 1.5); // stop bit
		}

		sendBit(1, wait);
		var CODE = 'LTRS';
		for (var i = 0, len = text.length; i < len; i++) {
			var char = text.charAt(i);
			if (char === "\x0f") {
				CODE = 'FIGS';
			} else
			if (char === "\x0e") {
				CODE = 'LTRS';
			}

			var code = RTTY.BAUDOT_CODE[CODE].indexOf(char);
			console.log([char, code]);
			sendChar(code);
		}
		sendBit(1, wait);

		return buffer;
	}
};


RTTY.init();

if (location.hash === '#debug') {
	RTTY.decode(
			function () {
				var source = RTTY.context.createBufferSource();
				source.buffer = RTTY.createAFSKBuffer('RYRY CQ CQ CQ DE JH1UMV JH1UMV JH1UMV PSE K', {
	//			source.buffer = RTTY.createAFSKBuffer('JH1UMV PSE K', {
					reverse : true,
					tone : 2125,
					shift : 170,
					baudrate: 45.45
				});
				// source.connect(RTTY.context.destination);
				source.start(1);
				return source;
			} ()
	);
}

navigator.getMedia({ video: false, audio: true }, function (stream) {
	var source = RTTY.context.createMediaStreamSource(stream);
	RTTY.decode(source);
}, function (e) {
	alert(e);
});

function playTest () {
	RTTY.playAFSK("RYRY CQ CQ CQ DE JH1UMV JH1UMV JH1UMV PSE K\r\n", {
		reverse : true,
		tone : 2125,
		shift : 170,
		baudrate: 45.45
	});
}
