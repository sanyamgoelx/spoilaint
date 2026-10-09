// node bench/fuzz/fuzz.js CASEDIR  -> runs every case through the browser engine; prints problems, exits 1 on any.
// A case passes if nothing throws, nothing takes over 5 s, every time is a finite number, words sit inside their
// line (or at its start), and the .ass output has no NaN/undefined/negative times.
const fs = require('fs'), path = require('path');
const S = require('../../engine/spoilaint-engine.js');
const dir = process.argv[2], bad = [];
let total = 0, withCues = 0;
const fin = (x) => typeof x === 'number' && isFinite(x);
for (const f of fs.readdirSync(dir).sort()) {
  total++;
  const buf = fs.readFileSync(path.join(dir, f));
  let text = buf.toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le');
  const t0 = Date.now();
  try {
    const r = S.parse(text, f.endsWith('.json') ? null : null);
    if (r && r.cues.length) {
      withCues++;
      for (const c of r.cues) {
        if (!fin(c.start) || !fin(c.end)) throw new Error('non-numeric line time ' + c.start + '..' + c.end);
        for (const w of c.words) {
          if (!fin(w.at)) throw new Error('word time ' + w.at);
          if (w.at < c.start || (w.at > Math.max(c.end, c.start) && !w.inst)) throw new Error(`word ${JSON.stringify(w.text)} at ${w.at} outside line ${c.start}..${c.end}`);
        }
      }
      for (const mode of ['word', 'chunk', 'off']) {
        const ass = S.toASS(r.cues, { mode, lag: 300 });
        const badLine = ass.split('\r\n').find((l) => /NaN|undefined|Infinity/.test(l) || (l.startsWith('Dialogue:') && !/^Dialogue: 0,\d+:\d\d:\d\d\.\d\d,\d+:\d\d:\d\d\.\d\d,/.test(l)));
        if (badLine) throw new Error(mode + ' .ass has a bad line: ' + badLine.slice(0, 120));
        const last = r.cues[r.cues.length - 1];
        for (const t of [0, r.cues[0].start, (r.cues[0].start + last.end) / 2, last.end + 5000]) S.stateAt(r.cues, t, { mode, lag: 300 });
      }
    }
  } catch (e) { bad.push(`${f}: ${e.message}`); }
  if (Date.now() - t0 > 5000) bad.push(`${f}: took ${Date.now() - t0} ms`);
}
for (const b of bad) console.log('  ' + b);
console.log(`browser engine: ${total} cases, ${withCues} parsed into lines, ${bad.length} problems`);
process.exit(bad.length ? 1 : 0);
