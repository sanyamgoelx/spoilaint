// node parity.js <in.srt> <out.ass> <mode> <lag>
const fs = require('fs');
const S = require('../../engine/spoilaint-engine.js');
const [inp, out, mode, lag] = process.argv.slice(2);
const buf = fs.readFileSync(inp);
let text;
if (buf[0] === 0xFF && buf[1] === 0xFE) text = new TextDecoder('utf-16le').decode(buf.subarray(2));
else { try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { text = new TextDecoder('windows-1252').decode(buf); } }
const cues = S.parseSRT(text);
fs.writeFileSync(out, S.toASS(cues, { mode, lag: +lag }));
