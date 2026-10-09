// node live_now.js bench_dir out.tsv  -> today's live listener (loudness only) on a bench film
global.self = global;
const fs = require('fs');
const S = require('../engine/spoilaint-engine.js'); global.Spoilaint = S;
require('../engine/spoilaint-listen.js');
const [dir, out] = process.argv.slice(2);
const cues = S.parse(fs.readFileSync(dir + '/bench.srt', 'utf8')).cues;
const est = cues.map(c => c.words.map(w => w.at));
const env = fs.readFileSync(dir + '/env.txt', 'utf8').match(/RMS_level=([-\d.inf]+)/g).map(s => { const v = parseFloat(s.split('=')[1]); return isFinite(v) ? v : -140; });
const video = { paused: false, seeking: false, currentTime: 0, addEventListener() {}, removeEventListener() {} };
const L = SpoilaintListen.attach(video, { getCues: () => cues, external: true });
for (let i = 0; i < env.length; i++) { video.currentTime = i * 0.02; L.pushFrame(env[i], i * 20); }
const rows = [];
cues.forEach((c, ci) => c.words.forEach((w, wi) => rows.push([ci, wi, w.text, est[ci][wi], Math.round(w.at)].join('\t'))));
fs.writeFileSync(out, rows.join('\n') + '\n');
