/*!
 * Spoilaint live listening: in the browser, hold each word back until it is actually heard.
 *
 * Works where the site lets a page read the video's sound (YouTube and most non-DRM players).
 * DRM sites (Netflix, Prime Video, Hotstar) hand over silence; we notice that and step back to the
 * estimate.
 *
 * How: the video's sound is copied (video.captureStream, playback is untouched) into a Web Audio
 * graph limited to the speech band. Every 20 ms we read its loudness. A frame counts as talking
 * when it is loud enough above the recent quiet level and its loudness wobbles like syllables do.
 * Syllables are loudness peaks inside talking. For the line on screen, word N is revealed once
 * the syllables of the words before it have been heard. If listening misses something, the
 * estimate plus 1.5 s still reveals the word, so nothing gets stuck.
 *
 *   var L = SpoilaintListen.attach(video, { getCues: () => cues });
 *   L.status()  // 'starting' | 'listening' | 'unavailable'
 *   L.detach()
 */
(function (root) {
  'use strict';

  var FRAME_MS = 20;
  var CFG = {
    historyFrames: 200,     // 4 s of loudness to learn the quiet and loud levels
    minDb: 6,               // talking is at least this far above the quiet level ...
    loudFrac: 0.5,          // ... and past this share of the quiet-to-loud range, or
    looseFrac: 0.35,        // past this share AND wobbling like speech (syllables)
    wobbleFrac: 0.5,        // wobble threshold between typical (0) and strongest (1) recent wobble
    peakDb: 2.5,            // a syllable peak rises this much above the dip before it
    peakGapFrames: 4,       // syllables at least 80 ms apart
    peaksPerSyllable: 1.3,  // detected peaks per expected syllable
    useVoice: true,         // let the voice detector decide (tab audio) once it has proven itself:
    trustAfter: 10,         // ... after this many lines, ...
    trustShare: 0.6,        // ... it must have heard a voice in this share of the last 20 lines
    voiceOn: 0.5,           // with the voice detector: speech probability that counts as talking
    perSyllableMs: 260,     // talking time per syllable when counting by time
    fallbackMs: 1500,
    staggerMs: 70,          // words heard in the same instant appear this far apart, so none is skipped over       // reveal on the estimate + this if listening hears nothing (always before the line ends)
    silentGiveUpMs: 8000    // playing this long with pure silence = the site blocks the sound
  };

  function attach(video, opts) {
    var S = root.Spoilaint;
    var state = 'starting';
    var ctx = null, analyser = null, timer = 0, buf = null, srcNode = null, stream = null;
    var hist = [];            // recent loudness values (dB)
    var wobHist = [];         // recent wobble values
    var wob = [];             // last 10 values for the wobble
    var silentMs = 0, heardSomething = false;
    var smooth = [-120, -120, -120];
    var dip = Infinity, lastPeakFrame = -999, frameNo = 0, levels = null;
    var current = null;       // {cue, peaks, voicedMs, started}
    var lastVideoMs = 0;
    var heardLines = [];      // per finished line: did the voice detector hear a voice in it?
    var alignMode = false;    // the speech model reveals words (tab audio); loudness only holds them back
    var bypass = false;       // don't hold words at all (muted, or subtitles that don't match the audio)
    function voiceTrusted() {
      if (!CFG.useVoice || heardLines.length < CFG.trustAfter) return false;
      return heardLines.filter(Boolean).length / heardLines.length >= CFG.trustShare;
    }

    function fail(why) {
      state = 'unavailable';
      stop();
      restoreAll();
      if (root.console && why) console.debug('[Spoilaint] live listening off:', why);
    }

    // Start only when it's useful and allowed: the video has subtitles to time, and the viewer has
    // clicked or pressed a key on the page. Chrome refuses (and logs an error for) audio started
    // before that, which used to happen on every page with a video, e.g. a shop's product video.
    var waitTimer = 0, gestureEvents = ['pointerdown', 'keydown'];
    function hasGesture() { var ua = root.navigator && root.navigator.userActivation; return !ua || ua.hasBeenActive; }
    function hasCues() { var c = opts.getCues(); return !!(c && c.length); }
    function tryStart() {
      if (ctx || state === 'unavailable' || !hasGesture() || !hasCues()) return;
      clearInterval(waitTimer); waitTimer = 0;
      start();
    }
    function resume() { if (ctx && ctx.state === 'suspended' && hasGesture()) ctx.resume(); }
    function onGesture() { if (ctx) resume(); else tryStart(); }
    function waitToStart() {
      gestureEvents.forEach(function (ev) { root.addEventListener(ev, onGesture, true); });
      waitTimer = setInterval(tryStart, 500);
      tryStart();
    }

    function start() {
      try {
        var cap = video.captureStream || video.mozCaptureStream;
        if (!cap) return fail('captureStream not supported');
        stream = cap.call(video);
      } catch (e) { return fail(e.message); }
      try {
        ctx = new (root.AudioContext || root.webkitAudioContext)();
      } catch (e) { return fail(e.message); }
      connect();
      stream.addEventListener && stream.addEventListener('addtrack', connect);
      resume();
      timer = setInterval(tick, FRAME_MS);
    }

    function connect() {
      if (!stream || !ctx || srcNode || !stream.getAudioTracks().length) return;
      try {
        srcNode = ctx.createMediaStreamSource(stream);
        var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 250;
        var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3500;
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        buf = new Float32Array(analyser.fftSize);
        srcNode.connect(hp); hp.connect(lp); lp.connect(analyser); // not connected to the speakers: playback is unchanged
        if (opts.onPcm) {
          // The page's sound at 16 kHz for the speech model (sent to the extension's offscreen page).
          // Two low-passes before dropping to 16 kHz (as the tab-audio path does), so nothing folds back.
          var aa = ctx.createBiquadFilter(); aa.type = 'lowpass'; aa.frequency.value = 7000;
          var aa2 = ctx.createBiquadFilter(); aa2.type = 'lowpass'; aa2.frequency.value = 7000;
          var proc = ctx.createScriptProcessor(4096, 1, 1);
          var silent = ctx.createGain(); silent.gain.value = 0;
          srcNode.connect(aa); aa.connect(aa2); aa2.connect(proc); proc.connect(silent); silent.connect(ctx.destination);
          var stepIn = ctx.sampleRate / 16000, fracIn = 0;
          proc.onaudioprocess = function (e) {
            if (video.paused || video.seeking) return;
            var x = e.inputBuffer.getChannelData(0), out = [], pos = fracIn;
            while (pos < x.length) {
              var i0 = Math.floor(pos), fr = pos - i0, a = x[i0], b = i0 + 1 < x.length ? x[i0 + 1] : a;
              var v = a + (b - a) * fr;
              out.push(Math.round((v > 1 ? 1 : v < -1 ? -1 : v) * 32767)); pos += stepIn;
            }
            fracIn = pos - x.length;
            opts.onPcm(out, Date.now());
          };
        }
      } catch (e) { fail(e.message); }
    }

    function stop() {
      clearInterval(timer); timer = 0;
      clearInterval(waitTimer); waitTimer = 0;
      gestureEvents.forEach(function (ev) { root.removeEventListener(ev, onGesture, true); });
      try { if (srcNode) srcNode.disconnect(); } catch (e) {}
      try { if (ctx) ctx.close(); } catch (e) {}
      ctx = null; analyser = null; srcNode = null;
    }

    function percentile(list, p) {
      var c = list.slice().sort(function (a, b) { return a - b; });
      return c[Math.max(0, Math.min(c.length - 1, Math.floor(p * c.length)))];
    }

    // Puts a cue's words back on the estimate (used when we stop listening or jump around).
    function restoreCue(cue) {
      if (!cue || !cue.live) return;
      cue.words.forEach(function (w) { if (w.est != null) w.at = w.est; w.aligned = false; });
      cue.live = false;
    }
    function restoreAll() {
      var cues = opts.getCues() || [];
      for (var i = 0; i < cues.length; i++) if (cues[i].live) restoreCue(cues[i]);
      current = null;
    }

    // The line on screen now (by the video clock, before any delay setting).
    function activeCue(cues, t) {
      for (var i = cues.length - 1; i >= 0 && i > cues.length - 2000; i--) {
        var c = cues[i];
        if (c.start <= t + 200 && t < c.end) return c.explicit ? null : c; // real word times already
        if (c.end < t - 60000) break;
      }
      return null;
    }

    function takeOver(cue, t) {
      // Hold spoken words back until heard; the estimate + fallbackMs is the latest they can appear.
      // Helper text ([laughs]) isn't held: it follows the spoken word before it.
      var total = 0;
      cue.words.forEach(function (w) {
        if (w.est == null) w.est = w.at;
        w.heard = false;
        w.weight = w.inst ? 0 : S._internal.weightOf(w.text);
        total += w.weight;
      });
      // Landed in the middle of a line (scrubbed or started mid-way): words the estimate says were
      // already said show at once, and listening carries on from there.
      var midway = t > cue.start + 300;
      var before = 0, base = 0, baseSet = false;
      cue.words.forEach(function (w) {
        w.pos = total ? before / total : 0; before += w.weight;
        if (w.inst || w.aligned) return;   // already placed by the speech model
        if (midway && w.est <= t) { w.at = w.est; return; }
        if (!baseSet) { base = w.pos; baseSet = true; }
        w.at = Math.max(w.est, Math.min(w.est + CFG.fallbackMs, cue.end - 300));
      });
      cue.totalWeight = total;
      cue.live = true;
      if (current && current.probFrames > 10) { heardLines.push(current.voiceMs >= 200); if (heardLines.length > 20) heardLines.shift(); }
      current = { cue: cue, peaks: 0, voicedMs: 0, voiceMs: 0, probFrames: 0, base: midway ? base : 0, firstAt: midway ? t : null };
    }

    // Scrubbing: forget the old position and relearn the sound level of the new scene.
    function onSeek() {
      restoreAll();
      hist = []; wobHist = []; wob = []; levels = null; smooth = [-120, -120, -120]; dip = Infinity;
      lastVideoMs = video.currentTime * 1000;
    }
    video.addEventListener('seeking', onSeek);

    function tick() {
      if (!analyser || !ctx || ctx.state !== 'running') return;
      if (video.paused || video.seeking) return;
      analyser.getFloatTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      var rms = Math.sqrt(sum / buf.length);
      processFrame(rms > 1e-7 ? 20 * Math.log10(rms) : -140, video.currentTime * 1000);
    }

    // One loudness reading (dB, speech band) at video time t (ms), plus the voice detector's speech
    // probability when available (tab audio). The detector tells voices from laughter and music.
    function processFrame(db, t, prob) {
      if (opts.onFrame) opts.onFrame(t, db, prob);
      if (bypass) return;
      // Jumped (seek) or a new video: start fresh.
      if (Math.abs(t - lastVideoMs) > 1500) restoreAll();
      lastVideoMs = t;

      // DRM sites give pure silence.
      if (db <= -120) { silentMs += FRAME_MS; if (!heardSomething && silentMs > CFG.silentGiveUpMs) return fail('no sound available (DRM?)'); }
      else { heardSomething = true; silentMs = 0; if (state === 'starting') state = 'listening'; }

      frameNo++;
      hist.push(db); if (hist.length > CFG.historyFrames) hist.shift();
      wob.push(db); if (wob.length > 10) wob.shift();
      smooth.push(db); smooth.shift();
      var e = (smooth[0] + smooth[1] + smooth[2]) / 3;
      if (hist.length < 25) return;
      var mean = wob.reduce(function (a, b) { return a + b; }, 0) / wob.length;
      var sd = Math.sqrt(wob.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / wob.length);
      wobHist.push(sd); if (wobHist.length > CFG.historyFrames) wobHist.shift();
      if (frameNo % 5 === 0 || levels == null) {
        levels = { quiet: percentile(hist, 0.15), loud: percentile(hist, 0.9), wLow: percentile(wobHist, 0.2), wHigh: percentile(wobHist, 0.9) };
      }
      var quiet = levels.quiet, range = levels.loud - quiet;
      var talking = e > quiet + Math.max(CFG.minDb, CFG.loudFrac * range) ||
        (e > quiet + Math.max(3, CFG.looseFrac * range) && sd > levels.wLow + CFG.wobbleFrac * (levels.wHigh - levels.wLow));
      // Once trusted, the voice detector decides alone: on Netflix's laugh tracks loudness says nothing.
      if (prob != null && voiceTrusted()) talking = prob >= CFG.voiceOn && e > quiet + 2;

      // Syllable peaks.
      var peak = false;
      if (talking) {
        if (e < dip) dip = e;
        if (smooth[1] > smooth[0] && smooth[1] >= smooth[2] && smooth[1] - dip >= CFG.peakDb && frameNo - lastPeakFrame >= CFG.peakGapFrames) {
          peak = true; lastPeakFrame = frameNo; dip = smooth[1];
        }
      } else dip = Infinity;

      // Don't hold any words back until we have actually heard sound (DRM sites send pure silence).
      if (state !== 'listening') return;
      var cues = opts.getCues() || [];
      var cue = activeCue(cues, t);
      if (!cue) { if (current) current = null; return; }
      if (!current || current.cue !== cue) takeOver(cue, t);
      var cur = current;
      if (prob != null) { cur.probFrames++; if (prob >= CFG.voiceOn) cur.voiceMs += FRAME_MS; }
      if (talking) {
        cur.voicedMs += FRAME_MS;
        if (cur.firstAt == null) cur.firstAt = t;
      }
      if (peak) cur.peaks++;
      if (cur.firstAt == null || alignMode) return;
      // How far into the line the speaker is: by syllables heard, or by talking time.
      var progress = cur.base + Math.max(cur.peaks / Math.max(1, cue.totalWeight * CFG.peaksPerSyllable),
        cur.voicedMs / Math.max(1, cue.totalWeight * CFG.perSyllableMs));
      // Several words heard at once (the speaker got ahead) appear one after another, not in a clump.
      var firstSpoken = true, next = Math.round(t);
      for (var k = 0; k < cue.words.length; k++) {
        var w = cue.words[k];
        if (w.inst) continue;                 // helper text follows the spoken word before it
        if (w.heard || w.at <= t) { firstSpoken = false; next = Math.max(next, w.at + CFG.staggerMs); continue; }
        if ((firstSpoken && !opts.awaitModel) || w.pos <= progress + 1e-6) {
          w.at = Math.min(next, Math.max(Math.round(t), w.at)); w.heard = true; firstSpoken = false;
          next = w.at + CFG.staggerMs;
        }
        else break;
      }
    }

    if (opts.external) state = 'starting'; else waitToStart();
    return {
      external: !!opts.external,
      // External sound (tab audio from the extension): one loudness reading at video time t.
      pushFrame: function (db, t, prob) {
        if (state === 'unavailable' || video.paused || video.seeking) return;
        processFrame(db, t, prob);
      },
      status: function () { return state; },
      setAlignMode: function (on) { alignMode = !!on; },
      // Estimate timing only (+ its safety margin): used when the sound can't be followed.
      setBypass: function (on) { on = !!on; if (on === bypass) return; bypass = on; if (on) restoreAll(); },
      bypassed: function () { return bypass; },
      voice: function () { return { trusted: voiceTrusted(), heard: heardLines.filter(Boolean).length, lines: heardLines.length }; },
      detach: function () { video.removeEventListener('seeking', onSeek); stop(); restoreAll(); state = 'unavailable'; }
    };
  }

  root.SpoilaintListen = { attach: attach, CFG: CFG };
})(typeof self !== 'undefined' ? self : this);
