/*!
 * Spoilaint live aligner: reveals each subtitle word once the speech model has heard it start.
 *
 * Runs NVIDIA's NeMo Conformer-CTC small (English, int8 ONNX, from k2-fsa/sherpa-onnx) with ONNX Runtime
 * Web, entirely on this computer. The subtitles say what will be said; the model only has to follow
 * where in the line the speaker is. Reference: bench/live_sim.py (same numbers) and bench/ctc_align.py.
 *
 *   var A = await SpoilaintAlign.createLive({ ort, modelUrl, tokensText, onReveal: (key, wordIndex, wallMs) => {} });
 *   A.push(float32Samples, sampleRate, wallMsOfLastSample);   // tab audio as it arrives
 *   A.setLines([{ key, start, end, words: [...], inst: [...] }], reset)  // start/end in wall-clock ms
 *
 * Every HOP ms while a line is on screen (or about to be): the model runs on the newest HOP ms plus CTX
 * ms before it; output for the newest REDO ms is recomputed next time (it lacked right context then).
 * Each line keeps a prefix-Viterbi over its tokens; the best state at the newest frame is how far into
 * the line the speaker is. Bench (real speech, music, laugh track): 0% of words early, ~0.55-0.9 s late,
 * ~10% of one core natively.
 */
(function (root) {
  'use strict';
  var RATE = 16000, FRAME_SAMPLES = 640, FRAME_MS = 40;
  // hop 160: ~90 ms less delay than 320 and half the clumped words, ~2x the work (still only while a line is up).
  // predictMargin: the next word may show at (previous word's heard start + its syllables at this line's pace + margin)
  // before the model confirms it; one word ahead only, never across punctuation. Bench: median delay 0.44 -> 0.27 s,
  // early words 0.2-0.4% (two words ahead: 2-8%, too many). bench/predict.py
  // tokenBonus: log-prob credit for entering each next token. Without it, staying put is cheaper whenever the model
  // is unsure (echo, cross-talk, noise: it mostly says "blank"), so the follower stalls and words fall back to late
  // estimates. Bench, first 4 min: echo median 1230 -> 469 ms late (words heard 32% -> 75%), worst-case film
  // 1361 -> 781, normal films 288 -> 256 and 520 -> 314, early words still <= 1.1%. 4+ starts showing words early.
  var CFG = { hop: 160, ctx: 800, redo: 600, lead: 300, tail: 300, onsetShift: -70, predictMargin: 200, paceMs: 210, tokenBonus: 3 };

  // ---------------------------------------------------------------- features (Kaldi fbank, 80 bins)
  var WIN = 400, SHIFT = 160, NFFT = 512, BINS = 80;
  var WINDOW = new Float64Array(WIN), BANK_START = [], BANK_W = [];
  (function () {
    for (var i = 0; i < WIN; i++) WINDOW[i] = Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1)), 0.85);
    function mel(f) { return 1127 * Math.log(1 + f / 700); }
    var ml = mel(20), mh = mel(8000), delta = (mh - ml) / (BINS + 1);
    for (var b = 0; b < BINS; b++) {
      var left = ml + b * delta, center = ml + (b + 1) * delta, right = ml + (b + 2) * delta, w = [], start = -1;
      for (var k = 0; k < NFFT / 2; k++) {
        var m = mel(k * RATE / NFFT);
        var v = (m <= left || m >= right) ? 0 : Math.max(0, Math.min((m - left) / (center - left), (right - m) / (right - center)));
        if (v > 0 && start < 0) start = k;
        if (start >= 0) w.push(v);
      }
      while (w.length && w[w.length - 1] === 0) w.pop();
      BANK_START.push(Math.max(0, start)); BANK_W.push(Float64Array.from(w));
    }
  })();
  var REV = new Uint16Array(NFFT);
  (function () { for (var i = 0, j = 0; i < NFFT; i++) { REV[i] = j; var bit = NFFT >> 1; while (j & bit) { j ^= bit; bit >>= 1; } j ^= bit; } })();
  var COS = new Float64Array(NFFT / 2), SIN = new Float64Array(NFFT / 2);
  for (var q = 0; q < NFFT / 2; q++) { COS[q] = Math.cos(-2 * Math.PI * q / NFFT); SIN[q] = Math.sin(-2 * Math.PI * q / NFFT); }
  function fft(re, im) {
    for (var i = 0; i < NFFT; i++) { var j = REV[i]; if (i < j) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (var len = 2; len <= NFFT; len <<= 1) {
      var half = len >> 1, step = NFFT / len;
      for (var s = 0; s < NFFT; s += len) {
        for (var k = 0; k < half; k++) {
          var a = s + k, b = a + half, cr = COS[k * step], ci = SIN[k * step];
          var tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  // x: Float32Array (16 kHz, -1..1) -> { data: Float32Array [80 x T] band-major, T }
  function fbank(x) {
    var n = x.length, T = Math.floor((n + 80) / SHIFT);
    var out = new Float32Array(BINS * Math.max(T, 1));
    if (T < 1) return { data: out, T: 0 };
    var re = new Float64Array(NFFT), im = new Float64Array(NFFT), fr = new Float64Array(WIN);
    var rows = new Float64Array(T * BINS);
    for (var t = 0; t < T; t++) {
      var s0 = t * SHIFT + 80 - 200, mean = 0;
      for (var i = 0; i < WIN; i++) {
        var j = s0 + i;
        if (j < 0) j = -j - 1; else if (j >= n) j = 2 * n - j - 1;
        j = Math.max(0, Math.min(n - 1, j));
        fr[i] = x[j] * 32768; mean += fr[i];
      }
      mean /= WIN;
      for (i = 0; i < WIN; i++) fr[i] -= mean;
      for (i = WIN - 1; i > 0; i--) fr[i] -= 0.97 * fr[i - 1];
      fr[0] -= 0.97 * fr[0];
      for (i = 0; i < NFFT; i++) { re[i] = i < WIN ? fr[i] * WINDOW[i] : 0; im[i] = 0; }
      fft(re, im);
      for (var b = 0; b < BINS; b++) {
        var e = 0, w = BANK_W[b], st = BANK_START[b];
        for (var k = 0; k < w.length; k++) { var qq = st + k; e += w[k] * (re[qq] * re[qq] + im[qq] * im[qq]); }
        rows[t * BINS + b] = Math.log(Math.max(e, 1.1920929e-07));
      }
    }
    for (b = 0; b < BINS; b++) {
      var m = 0, v = 0;
      for (t = 0; t < T; t++) m += rows[t * BINS + b];
      m /= T;
      for (t = 0; t < T; t++) { var d = rows[t * BINS + b] - m; v += d * d; }
      var sd = Math.sqrt(v / T) + 1e-5;
      for (t = 0; t < T; t++) out[b * T + t] = (rows[t * BINS + b] - m) / sd;
    }
    return { data: out, T: T };
  }

  // ---------------------------------------------------------------- words -> tokens
  var ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
  var TENS = '_ _ twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
  function say(n) {
    if (n < 20) return ONES[n];
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
    if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + say(n % 100) : '');
    if (n < 1e6) return say(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + say(n % 1000) : '');
    return String(n).split('').map(function (c) { return ONES[+c]; }).join(' ');
  }
  function sayDigits(s) {
    if (s.length > 15) return s.split('').map(function (c) { return ONES[+c]; }).join(' ');
    var n = parseInt(s, 10);
    if (s.length === 4 && n >= 1100 && n <= 2099 && n % 1000 >= 10)
      return say(Math.floor(n / 100)) + ' ' + (n % 100 < 10 ? 'oh ' + ONES[n % 100] : say(n % 100));
    return say(n);
  }
  function spoken(word) {
    var w = word.toLowerCase().replace(/[’‘]/g, "'");
    w = w.replace(/\d+/g, function (m) { return ' ' + sayDigits(m) + ' '; }).replace(/&/g, ' and ').replace(/%/g, ' percent ');
    w = w.replace(/[^a-z' ]+/g, ' ');
    return w.split(' ').map(function (p) { return p.replace(/^'+|'+$/g, ''); }).filter(Boolean);
  }
  // Syllables in a word (vowel groups), for the speaking pace.
  function syllables(w) {
    w = w.toLowerCase().replace(/[^a-z]/g, '');
    var g = (w.match(/[aeiouy]+/g) || []).length;
    if (w.length > 3 && g > 1 && /e$/.test(w) && !/le$/.test(w)) g--;
    return Math.max(1, g);
  }
  function pauseAfter(w) { return /[.,!?;:\u2026\-\u2014]["'\u201d\u2019)\]]*$/.test(w); }

  function Tokenizer(text) {
    var id = Object.create(null), maxLen = 0, blank = 0;
    text.split(/\r?\n/).forEach(function (l) {
      var sp = l.lastIndexOf(' ');
      if (sp <= 0) return;
      var v = parseInt(l.slice(sp + 1), 10);
      id[l.slice(0, sp)] = v; blank = Math.max(blank, v); maxLen = Math.max(maxLen, sp);
    });
    this.blank = blank;
    this.encode = function (w) {
      var out = [], s = '▁' + w, pos = 0;
      while (pos < s.length) {
        var found = false;
        for (var L = Math.min(maxLen, s.length - pos); L > 0; L--) {
          var piece = s.substr(pos, L);
          if (piece !== '<unk>' && id[piece] !== undefined) { out.push(id[piece]); pos += L; found = true; break; }
        }
        if (!found) pos++;
      }
      return out;
    };
  }

  // ---------------------------------------------------------------- one subtitle line being followed
  var NEG = -1e30;
  function LineState(line, tok, frameOf) {
    var toks = [], owner = [];
    line.words.forEach(function (w, wi) {
      if (line.inst && line.inst[wi]) return;
      spoken(w).forEach(function (p) { tok.encode(p).forEach(function (t) { toks.push(t); owner.push(wi); }); });
    });
    this.key = line.key; this.line = line;
    this.toks = toks; this.owner = owner;
    this.firstTok = {};
    for (var k = 0; k < owner.length; k++) if (this.firstTok[owner[k]] === undefined) this.firstTok[owner[k]] = k;
    var S = 2 * toks.length + 1;
    this.S = S;
    this.lab = new Int32Array(S); this.skip = new Uint8Array(S);
    for (var s = 0; s < S; s++) this.lab[s] = s % 2 ? toks[(s - 1) / 2] : tok.blank;
    for (s = 3; s < S; s += 2) this.skip[s] = this.lab[s] !== this.lab[s - 2] ? 1 : 0;
    this.hist = []; // [{f, dp, cum, n}]
    this.dp = null;
    this.cum = 0; this.n = 0;   // sum of each frame's best log-prob, frames fed (for the match score)
    this.done = false;
    this.revealed = {};
    this.heard = {};      // word -> { onset: wall ms the model heard it start, at: wall ms it was confirmed }
    this.predicted = {};
    this.update(line, frameOf);
  }
  LineState.prototype.update = function (line, frameOf) {
    this.line = line;
    this.fromF = frameOf(line.start - CFG.lead);
    this.toF = frameOf(line.end + CFG.tail);
  };
  LineState.prototype.feed = function (row, vocab, f) {
    var S = this.S, lab = this.lab;
    var rowMax = -Infinity;
    for (var v = 0; v < vocab; v++) if (row[v] > rowMax) rowMax = row[v];
    this.cum += rowMax; this.n++;
    var nd = new Float32Array(S);
    if (!this.dp) {
      for (var s = 0; s < S; s++) nd[s] = NEG;
      nd[0] = row[lab[0]]; if (S > 1) nd[1] = row[lab[1]];
    } else {
      var p = this.dp;
      for (s = 0; s < S; s++) {
        var best = p[s], enter = s & 1 ? CFG.tokenBonus : 0;
        if (s >= 1 && p[s - 1] + enter > best) best = p[s - 1] + enter;
        if (s >= 2 && this.skip[s] && p[s - 2] + enter > best) best = p[s - 2] + enter;
        nd[s] = best <= NEG / 2 ? NEG : best + row[lab[s]];
      }
    }
    this.dp = nd;
    this.hist.push({ f: f, dp: nd, cum: this.cum, n: this.n });
    if (this.hist.length > 400) this.hist.splice(0, this.hist.length - 400);
  };
  LineState.prototype.rollback = function (f) {
    while (this.hist.length && this.hist[this.hist.length - 1].f >= f) this.hist.pop();
    var h = this.hist.length ? this.hist[this.hist.length - 1] : null;
    this.dp = h ? h.dp : null; this.cum = h ? h.cum : 0; this.n = h ? h.n : 0;
    return h ? h.f : -Infinity;
  };
  // How much worse than unconstrained the best path through this line's words is, per frame.
  // Matching text: ~0.1-0.3; other words or another language: much higher (see bench/live_js.js).
  LineState.prototype.gap = function () {
    if (!this.dp || !this.n) return 0;
    // Every path to state s has entered the same (s + 1) >> 1 tokens, so taking the entry credit back out gives
    // each state's true best score: the same measure as before the credit existed.
    var best = -Infinity;
    for (var s = 0; s < this.S; s++) { var v = this.dp[s] - CFG.tokenBonus * ((s + 1) >> 1); if (v > best) best = v; }
    return (this.cum - best) / this.n;
  };
  // Frame where the best path entered token k (the word's start as the model heard it), by walking back
  // through the saved Viterbi columns from the best state now.
  LineState.prototype.entryFrame = function (k) {
    var h = this.hist, n = h.length;
    if (!n) return null;
    var dp = h[n - 1].dp, s = 0, bv = -Infinity;
    for (var q = 0; q < this.S; q++) if (dp[q] > bv) { bv = dp[q]; s = q; }
    var target = 2 * k + 1;
    if (s < target) return null;
    for (var i = n - 1; i > 0; i--) {
      var p = h[i - 1].dp, best = s, v = p[s], enter = s & 1 ? CFG.tokenBonus : 0;
      if (s >= 1 && p[s - 1] + enter > v) { v = p[s - 1] + enter; best = s - 1; }
      if (s >= 2 && this.skip[s] && p[s - 2] + enter > v) { v = p[s - 2] + enter; best = s - 2; }
      if (best < target) return h[i].f; // entered the token at this frame
      s = best;
    }
    return h[0].f;
  };
  LineState.prototype.position = function () {
    if (!this.dp) return -1;
    var bs = 0, bv = -Infinity;
    for (var s = 0; s < this.S; s++) if (this.dp[s] > bv) { bv = this.dp[s]; bs = s; }
    return bs % 2 ? (bs - 1) / 2 : bs / 2 - 1; // index of the last token entered
  };

  // ---------------------------------------------------------------- live follower
  async function createLive(opts) {
    var ort = opts.ort;
    var session = await ort.InferenceSession.create(opts.modelUrl, { executionProviders: opts.providers || ['wasm'], graphOptimizationLevel: 'all' });
    var tok = new Tokenizer(opts.tokensText);
    var cfg = Object.assign({}, CFG, opts.cfg || {});
    var now = opts.now || function () { return Date.now(); };

    // Audio: 16 kHz ring buffer; sample n was heard at wall time base + n / 16.
    var CAP = RATE * 30, ring = new Float32Array(CAP), total = 0, base = null, baseSeen = [];
    var frac = 0, prevSample = 0;
    var frames = new Map(); // absolute frame index -> logp row (Float32Array view)
    var vocab = 0;
    var lines = new Map(); // key -> LineState
    var running = false, lastRunEnd = 0, timer = 0, stats = { runs: 0, ms: 0, hop: cfg.hop };
    var avgMs = null, baseHop = cfg.hop, maxHop = Math.max(cfg.hop, 640);

    function frameOf(wall) { return base == null ? 0 : Math.floor((wall - base) * 16 / FRAME_SAMPLES); }
    function wallOfFrame(f) { return base + f * FRAME_MS; }

    function push(samples, rate, wallEnd) {
      var step = rate / RATE, pos = frac, added = 0;
      while (pos < samples.length) {
        var i = Math.floor(pos), f = pos - i;
        var a = i >= 0 ? samples[i] : prevSample, b = i + 1 < samples.length ? samples[i + 1] : a;
        ring[total % CAP] = a + (b - a) * f;
        total++; added++;
        pos += step;
      }
      frac = pos - samples.length;
      prevSample = samples[samples.length - 1];
      // Clock: the earliest-arriving estimate of "wall time of sample 0" (arrival jitter only adds delay).
      var est = wallEnd - total / 16;
      baseSeen.push(est); if (baseSeen.length > 400) baseSeen.shift();
      var m = Infinity; for (var k = 0; k < baseSeen.length; k++) if (baseSeen[k] < m) m = baseSeen[k];
      base = base == null ? m : Math.min(m, base + 0.05); // follow slow drift
    }

    function setLines(list, reset) {
      if (reset) { lines.clear(); frames.clear(); lastRunEnd = 0; }
      var keep = {};
      list.forEach(function (l) {
        keep[l.key] = true;
        var st = lines.get(l.key);
        if (st) st.update(l, frameOf);
        else if (base != null) lines.set(l.key, new LineState(l, tok, frameOf));
      });
      lines.forEach(function (st, k) { if (!keep[k] && st.toF < frameOf(now()) - 50) lines.delete(k); });
    }

    async function step() {
      if (running || base == null) return;
      var endS = total - (total % FRAME_SAMPLES); // whole frames only
      var endF = endS / FRAME_SAMPLES;
      var active = [];
      lines.forEach(function (st) { if (st.toks.length && st.fromF <= endF && st.toF >= endF - Math.ceil(cfg.hop / FRAME_MS)) active.push(st); });
      if (!active.length) { frames.clear(); lastRunEnd = 0; return; }
      if (endS - lastRunEnd * FRAME_SAMPLES < cfg.hop * 16 && lastRunEnd) return;
      var ctxS = (cfg.hop + cfg.ctx) * 16;
      var startS = Math.max(0, endS - ctxS, total - CAP + 1);
      startS -= startS % FRAME_SAMPLES;
      var n = endS - startS;
      if (n < 3200) return;
      running = true;
      try {
        var x = new Float32Array(n);
        for (var i = 0; i < n; i++) x[i] = ring[(startS + i) % CAP];
        var t0 = now();
        var fb = fbank(x);
        var out = await session.run({
          audio_signal: new ort.Tensor('float32', fb.data, [1, 80, fb.T]),
          length: new ort.Tensor('int64', BigInt64Array.from([BigInt(fb.T)]), [1])
        });
        var took = now() - t0;
        stats.runs++; stats.ms += took;
        // Stay light: if a step takes more than half its interval (slow or busy PC), step less often
        // (160 -> 240 -> ... -> 640 ms: a little more delay instead of a hot core); come back down when there is room.
        avgMs = avgMs == null ? took : avgMs * 0.9 + took * 0.1;
        if (avgMs > cfg.hop * 0.4 && cfg.hop < maxHop) cfg.hop += 80;
        else if (avgMs < cfg.hop * 0.2 && cfg.hop > baseHop) cfg.hop -= 80;
        stats.hop = cfg.hop;
        var lp = out.logprobs, F = lp.dims[1]; vocab = lp.dims[2];
        var startF = startS / FRAME_SAMPLES;
        // Replace the newest frames (they lacked right context before); keep 400 ms of left context unused.
        var redoF = lastRunEnd ? Math.max(startF + 10, lastRunEnd - Math.round(cfg.redo / FRAME_MS)) : startF;
        for (var f = 0; f < F; f++) {
          var af = startF + f;
          if (af >= redoF) frames.set(af, lp.data.subarray(f * vocab, (f + 1) * vocab));
        }
        frames.forEach(function (_, k) { if (k < endF - 250) frames.delete(k); });
        lastRunEnd = startF + F;
        var nowWall = now();
        active.forEach(function (st) {
          var lastF = st.rollback(redoF);
          for (var ff = Math.max(lastF + 1, st.fromF); ff <= Math.min(st.toF, startF + F - 1); ff++) {
            var row = frames.get(ff);
            if (row) st.feed(row, vocab, ff);
          }
          if (!st.done && st.toF <= startF + F - 1 && st.n > 0) {
            st.done = true;
            if (opts.onLineDone) opts.onLineDone(st.key, st.gap(), st.n, st.position() + 1, st.toks.length);
          }
          predict(st, nowWall);
          var pos = st.position();
          for (var wi = 0; wi < st.line.words.length; wi++) {
            var k = st.firstTok[wi];
            if (k !== undefined && k <= pos && !st.revealed[wi]) {
              st.revealed[wi] = true;
              var ef = st.entryFrame(k);
              var onset = ef == null ? null : wallOfFrame(ef) + cfg.onsetShift;
              if (onset != null) st.heard[wi] = { onset: onset, at: nowWall };
              if (opts.onReveal) opts.onReveal(st.key, wi, nowWall, onset);
            }
          }
        });
      } catch (e) {
        if (opts.onError) opts.onError(e);
      }
      running = false;
    }

    // The word after the last one heard: show it when it should start at this line's pace (+ margin),
    // unless the model hears it first. Only one word ahead and never across a pause.
    function predict(st, nowWall) {
      if (!cfg.predictMargin) return;
      var words = st.line.words, inst = st.line.inst || [];
      var spoken = [];
      for (var i = 0; i < words.length; i++) if (!inst[i] && st.firstTok[i] !== undefined) spoken.push(i);
      for (var n = 1; n < spoken.length; n++) {
        var j = spoken[n], L = spoken[n - 1];
        if (st.revealed[j] || st.predicted[j]) continue;
        var hl = st.heard[L];
        if (!hl || pauseAfter(words[L]) || /^[-\u2013\u2014\u266a]/.test(words[j])) break;
        // pace from the words of this line heard so far
        var first = null, last = null, syl = 0;
        for (var q = 0; q <= n - 1; q++) {
          var h = st.heard[spoken[q]];
          if (!h) continue;
          if (first == null) first = q;
          last = q;
        }
        var pace = cfg.paceMs;
        if (first != null && last > first && st.heard[spoken[last]].onset > st.heard[spoken[first]].onset) {
          for (q = first; q < last; q++) syl += syllables(words[spoken[q]]);
          pace = (st.heard[spoken[last]].onset - st.heard[spoken[first]].onset) / Math.max(1, syl);
        }
        pace = Math.max(120, Math.min(320, pace));
        var when = Math.max(hl.at, hl.onset + syllables(words[L]) * pace + cfg.predictMargin);
        st.predicted[j] = true;
        if (opts.onReveal) opts.onReveal(st.key, j, when, null, true);
        break;
      }
    }

    if (!opts.manual) timer = setInterval(step, 20);
    return {
      push: push, setLines: setLines, step: step,
      stats: function () { return { runs: stats.runs, avgMs: stats.runs ? Math.round(stats.ms / stats.runs) : 0, lines: lines.size, hop: stats.hop }; },
      reset: function () { lines.clear(); frames.clear(); lastRunEnd = 0; total = 0; base = null; baseSeen = []; frac = 0; },
      stop: function () { clearInterval(timer); timer = 0; }
    };
  }

  root.SpoilaintAlign = { createLive: createLive, fbank: fbank, spoken: spoken, Tokenizer: Tokenizer, CFG: CFG, syllables: syllables };
})(typeof self !== 'undefined' ? self : this);
