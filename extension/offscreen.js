/*
 * Spoilaint offscreen page: records the chosen tab's sound, keeps it playing to the speakers
 * (Chrome mutes a tab while it is being recorded), and measures dialogue loudness every 20 ms.
 * Readings go to the background page in batches; nothing is stored or sent anywhere else.
 */
'use strict';

var ctx = null, stream = null, timer = 0, batchTimer = 0, tabId = null;
var analyser = null, buf = null, batch = [], vad = null, vadNote = '';
var aligner = null, alignNote = '';
var alignTab = null, pagePushes = 0; // the tab the speech model is following

ort.env.wasm.wasmPaths = chrome.runtime.getURL('vad/');
ort.env.wasm.numThreads = 1;

// 0.6.0: the speech model follows the subtitle words as they are spoken (all local). If it can't load,
// we fall back to the voice detector (Silero VAD) + loudness, as before.
var alignReady = (async function () {
  try {
    var tokens = await (await fetch(chrome.runtime.getURL('speech/tokens.txt'))).text();
    aligner = await SpoilaintAlign.createLive({
      ort: ort, modelUrl: chrome.runtime.getURL('speech/model.int8.onnx'), tokensText: tokens,
      onReveal: function (key, word, wall) {
        chrome.runtime.sendMessage({ type: 'align-reveal', tabId: alignTab, key: key, word: word, wall: wall }).catch(function () {});
      },
      onError: function (e) { alignNote = String(e && e.message || e); },
      // How well each finished line matched the sound (the tab decides if the subtitles fit the audio).
      onLineDone: function (key, gap, frames) {
        chrome.runtime.sendMessage({ type: 'align-line-score', tabId: alignTab, key: key, gap: gap, frames: frames }).catch(function () {});
      }
    });
  } catch (e) { aligner = null; alignNote = String(e && e.message || e); }
})();
var vadReady = (async function () {
  await alignReady;
  if (aligner) return; // the speech model already tells voices from laughter and music
  try {
    vad = await SpoilaintVAD.create({ ort: ort, modelUrl: chrome.runtime.getURL('vad/silero_vad_v5.onnx'), onError: function (e) { vadNote = String(e); } });
  } catch (e) { vad = null; vadNote = String(e && e.message || e); }
})();

async function start(streamId, tab) {
  stop();
  tabId = tab;
  alignTab = tab;
  if (aligner) aligner.reset();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });
  // If Chrome ends the capture (tab closed, another site), tell the background.
  stream.getAudioTracks().forEach(function (t) {
    t.addEventListener('ended', function () { chrome.runtime.sendMessage({ type: 'capture-ended', tabId: tabId }).catch(function () {}); });
  });
  ctx = new AudioContext();
  var src = ctx.createMediaStreamSource(stream);
  src.connect(ctx.destination); // keep the tab audible
  var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 250;
  var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3500;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  buf = new Float32Array(analyser.fftSize);
  src.connect(hp); hp.connect(lp); lp.connect(analyser);
  await vadReady;
  if (vad || aligner) {
    try {
      await ctx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
      var tap = new AudioWorkletNode(ctx, 'pcm-tap');
      var mute = ctx.createGain(); mute.gain.value = 0;
      // Low-pass before going down to 16 kHz for the model (avoids aliasing).
      var aa1 = ctx.createBiquadFilter(); aa1.type = 'lowpass'; aa1.frequency.value = 7000;
      var aa2 = ctx.createBiquadFilter(); aa2.type = 'lowpass'; aa2.frequency.value = 7000;
      src.connect(aa1); aa1.connect(aa2); aa2.connect(tap); tap.connect(mute); mute.connect(ctx.destination);
      var rate = ctx.sampleRate;
      tap.port.onmessage = function (e) {
        if (aligner) aligner.push(e.data, rate, Date.now());
        if (vad) vad.push(e.data, rate);
      };
    } catch (e) { vadNote = String(e && e.message || e); vad = null; }
  }
  timer = setInterval(function () {
    analyser.getFloatTimeDomainData(buf);
    var sum = 0;
    for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    var rms = Math.sqrt(sum / buf.length);
    // Wall-clock time of the reading; the tab maps it to the video's clock.
    var p = vad ? vad.latest() : null;
    batch.push([Date.now(), rms > 1e-7 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -140, p == null ? null : Math.round(p * 100) / 100]);
  }, 20);
  batchTimer = setInterval(function () {
    if (!batch.length) return;
    chrome.runtime.sendMessage({ type: 'audio-frames', tabId: tabId, frames: batch, vad: vad ? 'on' : ('off: ' + vadNote).slice(0, 200), gain: vad ? Math.round(vad.gain() * 10) / 10 : null,
      aligner: aligner ? 'on' : ('off: ' + alignNote).slice(0, 200), alignStats: aligner ? aligner.stats() : null });
    batch = [];
  }, 50);
}

function stop() {
  clearInterval(timer); clearInterval(batchTimer); timer = batchTimer = 0;
  if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); // un-mutes the tab
  if (ctx) ctx.close();
  stream = null; ctx = null; analyser = null; batch = [];
  if (vad) vad.reset();
  if (aligner) aligner.reset();
  alignTab = null;
}

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'start') {
    start(msg.streamId, msg.tabId).then(function () { reply({ ok: true }); }, function (e) { reply({ ok: false, error: e.message }); });
    return true;
  }
  if (msg.type === 'stop') { stop(); reply({ ok: true }); }
  // The tab's upcoming subtitle lines, in wall-clock time, for the speech model to follow.
  if (msg.type === 'align-lines' && aligner && msg.tabId === alignTab) aligner.setLines(msg.lines || [], !!msg.reset);
  // A page's own sound (no tab capture): follow it unless a captured tab owns the model.
  if (msg.type === 'page-audio') {
    if (stream) return;
    alignReady.then(function () {
      if (!aligner) {
        if (pagePushes++ % 100 === 0) chrome.runtime.sendMessage({ type: 'align-state', tabId: msg.tabId, state: ('off: ' + alignNote).slice(0, 200) }).catch(function () {});
        return;
      }
      if (alignTab !== msg.tabId) { aligner.reset(); alignTab = msg.tabId; pagePushes = 0; }
      var pcm = msg.pcm, f = new Float32Array(pcm.length);
      for (var i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      aligner.push(f, 16000, msg.wall);
      if (pagePushes++ % 25 === 0) chrome.runtime.sendMessage({ type: 'align-state', tabId: msg.tabId, state: 'on' }).catch(function () {});
    });
  }
});
