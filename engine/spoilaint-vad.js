/*!
 * Spoilaint voice detector: tells people talking apart from laughter, music and effects.
 *
 * Runs the Silero VAD v5 model (MIT licence, ~2 MB) with ONNX Runtime Web (WebAssembly), entirely on
 * this computer. Feed it raw audio at any sample rate; it resamples to 16 kHz and reports a speech
 * probability (0..1) every 32 ms.
 *
 *   var vad = await SpoilaintVAD.create({ ort: window.ort, modelUrl: '.../silero_vad_v5.onnx' });
 *   vad.push(float32Samples, sampleRate);   // as audio arrives
 *   vad.latest()                            // most recent speech probability, or null before the first one
 */
(function (root) {
  'use strict';
  var WINDOW = 512, RATE = 16000;
  // The model's scores depend on loudness: quiet speech scores low, loud crowd laughter scores high.
  // Netflix's tab audio arrives ~25-30 dB quiet, so the level is evened out first: the loud part of the
  // last ~8 s is brought to TARGET_RMS (turned up or down). Tuned on real speech + real crowd laughter
  // (ESC-50): speech caught 75%, laughter mistaken 3%, at any input level. 0.15 (0.4.1) let laughter in (25%).
  var TARGET_RMS = 0.04, MAX_GAIN = 100, MIN_GAIN = 0.1, HISTORY = 250;

  async function create(opts) {
    var ort = opts.ort;
    var session = await ort.InferenceSession.create(opts.modelUrl, { executionProviders: opts.providers || ['wasm'] });
    var state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    var sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(RATE)]), []);
    var pending = new Float32Array(WINDOW), filled = 0;
    var queue = [], running = false, latest = null, frac = 0;
    var levels = [], gain = 1;
    var target = opts.targetRms || TARGET_RMS, maxGain = opts.maxGain || MAX_GAIN, pct = opts.levelPct != null ? opts.levelPct : 0.9, minGain = opts.minGain || MIN_GAIN;

    function level(chunk) {
      var sum = 0;
      for (var i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
      var rms = Math.sqrt(sum / chunk.length);
      if (rms > 1e-5) { levels.push(rms); if (levels.length > HISTORY) levels.shift(); }
      if (levels.length >= 8) {
        var sorted = levels.slice().sort(function (a, b) { return a - b; });
        var loud = sorted[Math.floor(sorted.length * pct)];
        var want = Math.max(minGain, Math.min(maxGain, target / loud));
        gain = gain * 0.9 + want * 0.1; // ease in, no pumping
      }
      if (gain !== 1) for (var j = 0; j < chunk.length; j++) chunk[j] = Math.max(-1, Math.min(1, chunk[j] * gain));
      return chunk;
    }

    async function drain() {
      if (running) return;
      running = true;
      try {
        while (queue.length) {
          var chunk = queue.shift();
          var out = await session.run({ input: new ort.Tensor('float32', chunk, [1, WINDOW]), state: state, sr: sr });
          state = out.stateN;
          latest = out.output.data[0];
          if (opts.onProb) opts.onProb(latest);
        }
      } catch (e) {
        if (opts.onError) opts.onError(e);
      }
      running = false;
    }

    // Linear resampling to 16 kHz, carried across calls.
    function push(samples, rate) {
      var step = rate / RATE;
      var pos = frac;
      while (pos < samples.length) {
        var i = Math.floor(pos), f = pos - i;
        var a = samples[i];
        var b = i + 1 < samples.length ? samples[i + 1] : a;
        pending[filled++] = a + (b - a) * f;
        if (filled === WINDOW) {
          if (queue.length < 8) queue.push(level(pending.slice(0))); // if we fall behind, drop rather than lag
          filled = 0;
        }
        pos += step;
      }
      frac = pos - samples.length;
      drain();
    }

    return {
      push: push,
      latest: function () { return latest; },
      gain: function () { return gain; },
      reset: function () { state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]); latest = null; levels = []; gain = 1; }
    };
  }

  root.SpoilaintVAD = { create: create };
})(typeof self !== 'undefined' ? self : this);
