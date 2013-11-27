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
	},

	decode : function (source) {
		var self = this;

		var gain = self.context.createGain();
		gain.gain.value = 0.5;

		var markOSC_I = self.context.createOscillator();
		markOSC_I.type = 1;
		markOSC_I.frequency.value = 2125;
		var markOSC_Q = self.context.createOscillator();
		markOSC_Q.type = 1;
		markOSC_Q.frequency.value = 2125;

		var markMixer_I = self.context.createGain();
		source.connect(markMixer_I);
		markOSC_I.connect(markMixer_I);
		var markMixer_Q = self.context.createGain();
		source.connect(markMixer_Q);
		markOSC_Q.connect(markMixer_Q);

		var markFilter_I = self.context.createBiquadFilter();
		markFilter_I.type = 0; // low pass
		markFilter_I.frequency.value = 100;
		markFilter_I.Q.value = 1000;
		markMixer_I.connect(markFilter_I);

		var markFilter_Q = self.context.createBiquadFilter();
		markFilter_Q.type = 0; // low pass
		markFilter_Q.frequency.value = 100;
		markFilter_Q.Q.value = 1000;
		markMixer_Q.connect(markFilter_Q);

		source.connect(markMixer_I);
		source.connect(markMixer_Q);

		markOSC_I.start(self.context.currentTime);
		markOSC_Q.start(self.context.currentTime + (1/2125/4));

		var merger = self.context.createChannelMerger(4);
		markFilter_I.connect(merger);
		markFilter_Q.connect(merger);

		var processor = self.context.createScriptProcessor(4096, 2, 1);
		processor.onaudioprocess = function (e) {
			processor.onaudioprocess = arguments.callee;
			console.log('on');

			var markData_I = e.inputBuffer.getChannelData(0);
			var markData_Q = e.inputBuffer.getChannelData(1);

			var markOutput = e.outputBuffer.getChannelData(0);
			for (var i = 0, len = e.inputBuffer.length; i < len; i++) {
				markOutput[i] = Math.sqrt(markData_I[i] * markData_I[i] + markData_Q[i] * markData_Q[i]);
			}
		};
		merger.connect(processor);
		processor.connect(gain);

		var analyser = self.context.createAnalyser();
		var data = new Uint8Array(analyser.frequencyBinCount);
		var canvas = document.getElementById('canvas');
		var ctx = canvas.getContext('2d');
		setInterval(function () {
			analyser.getByteTimeDomainData(data);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.beginPath();
			ctx.moveTo(0, 0);
			for (var i = 0, len = data.length; i < len; i++) {
				ctx.lineTo(i, data[i] / 0xff * canvas.height);
			}
			ctx.stroke();
		}, 10);
		analyser.connect(gain);

		gain.connect(self.context.destination);
	},


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
	},

	playAFSK : function (text, opts) {
		var self = this;

		var source = self.context.createBufferSource();
		source.buffer = RTTY.createAFSKBuffer(text, opts);

		var bandpass = self.context.createBiquadFilter();
		bandpass.type = 2;
		bandpass.frequency.value = 2125;
		bandpass.Q.value = 5;

		source.connect(bandpass);
		bandpass.connect(self.context.destination);
		source.start(0);
	},

	sketch : function () {
		var self = this;
		var source = function () {
//			var osc = self.context.createOscillator();
//			osc.type = 1;
//			osc.frequency.value = 2125;
//			osc.start(0);
//			var source = self.context.createGain();
//			setInterval(function () {
//				source.flag = !source.flag;
//				source.gain.value = source.flag ? 0.5 : 0;
//			}, 22);
//			osc.connect(source);
//			return source;

			var source = self.context.createBufferSource();
			source.buffer = RTTY.createAFSKBuffer('RY RY CQ CQ CQ DE JH1UMV JH1UMV JH1UMV PSE K', {
//			source.buffer = RTTY.createAFSKBuffer('JH1UMV PSE K', {
				reverse : true,
				tone : 2125,
				shift : 170,
				baudrate: 45.45
			});
			source.start(1);
			return source;
		} ();

		var n = 0;
		var toneMark = self.context.sampleRate / (2 * Math.PI * 2125);
		var toneSpace = self.context.sampleRate / (2 * Math.PI * (2125 + 170));

		var iq = self.context.createScriptProcessor(4096, 1, 4);
		iq.onaudioprocess = function (e) {
			var data = e.inputBuffer.getChannelData(0);
			var outputMarkI = e.outputBuffer.getChannelData(0);
			var outputMarkQ = e.outputBuffer.getChannelData(1);
			var outputSpaceI = e.outputBuffer.getChannelData(2);
			var outputSpaceQ = e.outputBuffer.getChannelData(3);
			for (var i = 0, len = e.inputBuffer.length; i < len; i++) {
				outputMarkI[i] = (Math.sin(n / toneMark) > 0 ? 1 : -1) * data[i];
				outputMarkQ[i] = (Math.cos(n / toneMark) > 0 ? 1 : -1) * data[i];
				outputSpaceI[i] = (Math.sin(n / toneSpace) > 0 ? 1 : -1) * data[i];
				outputSpaceQ[i] = (Math.cos(n / toneSpace) > 0 ? 1 : -1) * data[i];
				n++;
			}
		};
		source.connect(iq);
		console.log(iq);

		var filter = self.context.createBiquadFilter();
		filter.type = 0; // low pass
		filter.frequency.value = 100;
		filter.Q.value = 0;
		iq.connect(filter);

		var outputBuffer = new RingBuffer(new Int8Array(Math.pow(2, 11)));
		var DOWNSAMPLE_FACTOR = 64;
		var unit  = Math.round(self.context.sampleRate / DOWNSAMPLE_FACTOR / 45.45);
		var current = {
			state : "waiting",
			total : 0,
			mark : 0,
			space: 0,
			bit  : 0,
			byte : 0,
			set  : RTTY.BAUDOT_CODE.LTRS
		};

		var detection = self.context.createScriptProcessor(4096, 4, 2);
		detection.onaudioprocess = function (e) {
			var inputMarkI  = e.inputBuffer.getChannelData(0);
			var inputMarkQ  = e.inputBuffer.getChannelData(1);
			var inputSpaceI = e.inputBuffer.getChannelData(2);
			var inputSpaceQ = e.inputBuffer.getChannelData(3);

			var outputMark  = e.outputBuffer.getChannelData(0);
			var outputSpace = e.outputBuffer.getChannelData(1);
			for (var i = 0, len = e.inputBuffer.length; i < len; i += DOWNSAMPLE_FACTOR) { // down sample
				outputMark[i]  = Math.sqrt(inputMarkI[i]  * inputMarkI[i]  + inputMarkQ[i]  * inputMarkQ[i]);
				outputSpace[i] = Math.sqrt(inputSpaceI[i] * inputSpaceI[i] + inputSpaceQ[i] * inputSpaceQ[i]);
				if (outputMark[i] > outputSpace[i]) {
					outputBuffer.put(outputMark[i] > 0.3 ? 1 : 0);
				} else {
					outputBuffer.put(outputSpace[i] > 0.3 ? -1 : 0);
				}
				var data = outputBuffer.get(0);

				switch (current.state) {
					case "waiting":
						if (data === -1) {
							current.state = "start";
						} else {
							current.total = 0;
						}
						break;
					case "start":
						if (unit <= current.total) {
							console.log('start bit');
							current.total = 0;
							current.state = "data";
						}
						break;
					case "data":
						if (data ===  1) current.mark++;
						if (data === -1) current.space++;
						if (unit <= current.total) {
							console.log(current);
							var bit = current.mark > current.space ? 1 : 0;
							current.mark = 0; current.space = 0;
							current.byte = current.byte | (bit<<current.bit++);
							current.total = 0;

							if (current.bit >= 5) {
								current.bit = 0;
								current.state = "stop";
							}
						}
						break;
					case "stop":
						if (unit <= current.total) {
							console.log('stop bit');
							var char = current.set[current.byte];
							if (char === "\x0f") {
								current.set = RTTY.BAUDOT_CODE.FIGS;
							} else
							if (char === "\x0e") {
								current.set = RTTY.BAUDOT_CODE.LTRS;
							} else {
								console.log(current.byte.toString(2), current.byte, char);
								document.getElementById('text').value += char;
							}
							current.byte = 0;
							current.state = "waiting";
							current.total = 0;
						}
						break;
				}

				current.total++;
			}
		};
		filter.connect(detection);

		var outputGain = self.context.createGain();
		outputGain.gain.value = 0;
		detection.connect(outputGain);
		outputGain.connect(self.context.destination);

		console.log(detection);

		var canvas = document.getElementById('canvas');
		var ctx = canvas.getContext('2d');
		setInterval(function () {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.beginPath();
			ctx.moveTo(0, 0);
			for (var i = 0, len = outputBuffer.length; i < len; i++) {
				var n = outputBuffer.get(i);
				ctx.lineTo(
					canvas.width * (i / len),
					canvas.height - (n * 0.5 * canvas.height + canvas.height / 2)
				);
			}
			ctx.stroke();
		}, 500);

//		analysis(detection);
//
//		function analysis (node) {
//			var analyser = self.context.createAnalyser();
//			var data = new Uint8Array(analyser.frequencyBinCount);
//			var canvas = document.getElementById('canvas');
//			var ctx = canvas.getContext('2d');
//			setInterval(function () {
//				analyser.getByteTimeDomainData(data);
//				ctx.clearRect(0, 0, canvas.width, canvas.height);
//				ctx.beginPath();
//				ctx.moveTo(0, 0);
//				for (var i = 0, len = data.length; i < len; i++) {
//					ctx.lineTo(canvas.width * (i / len), canvas.height - (data[i] / 0xff * canvas.height));
//				}
//				ctx.stroke();
//			}, 50);
//			node.connect(analyser);
//			var outputGain = self.context.createGain();
//			outputGain.gain.value = 0;
//			outputGain.connect(self.context.destination);
//			analyser.connect(outputGain);
//		}
	}
};


RTTY.init();
RTTY.sketch();

//var source = RTTY.context.createBufferSource();
//source.buffer = RTTY.createAFSKBuffer("RYRY CQ CQ CQ DE JH1UMV JH1UMV JH1UMV PSE K", {
//	reverse : true,
//	tone : 2125,
//	shift : 170,
//	baudrate: 45.45
//});
//
//RTTY.decode(source);
//source.start(0);
//
//RTTY.playAFSK("RYRY CQ CQ CQ DE JH1UMV JH1UMV JH1UMV PSE K", {
//	reverse : true,
//	tone : 2125,
//	shift : 170,
//	baudrate: 45.45
//});
//RTTY.playAFSK("Hello World!");
