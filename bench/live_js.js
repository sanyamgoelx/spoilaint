// node live_js.js MODEL_DIR bench_dir out.tsv  -> the extension's live aligner (engine/spoilaint-align.js) on a bench film
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
global.self = global;
const ort = require(process.env.ORT_WEB || 'onnxruntime-web');
ort.env.wasm.numThreads = 1;
const S = require('../engine/spoilaint-engine.js'); global.Spoilaint = S;
require('../engine/spoilaint-align.js');
if (process.env.TOKBONUS) SpoilaintAlign.CFG.tokenBonus = +process.env.TOKBONUS;
const [modelDir, dir, out] = process.argv.slice(2);
(async () => {
  const cues = S.parse(fs.readFileSync(dir + '/bench.srt', 'utf8')).cues;
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', dir + '/bench_stereo.mkv', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
  const audio = new Float32Array(pcm.length / 2); for (let i = 0; i < audio.length; i++) audio[i] = pcm.readInt16LE(2 * i) / 32768;
  const OFF = 1e6; let clock = OFF; const DELAY = 100;
  const reveals = {}; const scores = []; const onsets = {};
  const A = await SpoilaintAlign.createLive({
    ort, modelUrl: modelDir + '/model.int8.onnx', tokensText: fs.readFileSync(modelDir + '/tokens.txt', 'utf8'), manual: true, now: () => clock, cfg: Object.assign(process.env.HOP ? { hop: +process.env.HOP } : {}, process.env.CTX ? { ctx: +process.env.CTX } : {}),
    onReveal: (key, wi, wall, onset, predicted) => { const R = (reveals[key] = reveals[key] || {}); const t = predicted ? wall - OFF : wall - OFF + DELAY; if (R[wi] == null || t < R[wi]) R[wi] = t; if (onset != null) (onsets[key] = onsets[key] || {})[wi] = Math.round(onset - OFF); }, onError: e => console.error(e), onLineDone: (key, gap, n, pos, ntok) => scores.push([key, gap.toFixed(3), n, pos, ntok].join('\t'))
  });
  const CH = 320; // 20 ms chunks
  let lastPlan = -1e9;
  const limit = process.env.MAXSEC ? +process.env.MAXSEC * 16000 : audio.length; // MAXSEC: only the first part (quick experiments)
  for (let s = 0; s + CH <= Math.min(limit, audio.length); s += CH) {
    clock = OFF + (s + CH) / 16;
    A.push(audio.subarray(s, s + CH), 16000, clock);
    const vt = clock - OFF;
    if (vt - lastPlan >= 1000) { // like the content script: plan for lines from 2 s ago to 10 s ahead
      lastPlan = vt;
      const plan = [];
      cues.forEach((c, ci) => { if (c.end > vt - 2000 && c.start < vt + 10000) plan.push({ key: ci, start: c.start + OFF, end: c.end + OFF, words: c.words.map(w => w.text), inst: c.words.map(w => !!w.inst) }); });
      A.setLines(plan, false);
    }
    await A.step();
  }
  const rows = [];
  cues.forEach((c, ci) => { if (c.end + 2000 > limit / 16) return; let last = -1; c.words.forEach((w, wi) => {
    let r = reveals[ci] && reveals[ci][wi];
    if (r == null) r = Math.max(w.at + 300, Math.min(w.at + 1500, c.end - 300));
    const al = reveals[ci] && reveals[ci][wi] != null ? 1 : 0; r = Math.max(r, last); last = r; rows.push([ci, wi, w.text, w.at, Math.round(r), al, (onsets[ci] && onsets[ci][wi] != null) ? onsets[ci][wi] : ''].join('\t')); }); });
  fs.writeFileSync(out, rows.join('\n') + '\n'); fs.writeFileSync(out + '.scores', scores.join('\n') + '\n');
  console.error('stats', JSON.stringify(A.stats()));
})();
