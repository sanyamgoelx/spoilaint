// Run: node engine/test/engine.test.js
const assert = require('assert');
const S = require('../spoilaint-engine.js');
const I = S._internal;
let n = 0;
function t(name, fn) { fn(); n++; console.log('ok', name); }

t('syllable weights', () => {
  const w = (x) => I.weightOf(x);
  assert.strictEqual(w('door'), 1);
  assert.strictEqual(w('checked'), 1);
  assert.strictEqual(w('wanted'), 2);
  assert.strictEqual(w('time'), 1);
  assert.strictEqual(w('little'), 2);
  assert.strictEqual(w('already'), 3);
  assert.strictEqual(w('opened.'), 2);
  assert.strictEqual(w('मुझे'), 2);
  assert.strictEqual(w('1999'), 4);
  assert.strictEqual(w('♪'), S.TUNING.noLetterWeight);
});

t('pauses', () => {
  assert.strictEqual(I.pauseAfter('it...'), S.TUNING.pauseEllipsis);
  assert.strictEqual(I.pauseAfter('inside."'), S.TUNING.pauseStop);
  assert.strictEqual(I.pauseAfter('हो।'), S.TUNING.pauseStop);
  assert.strictEqual(I.pauseAfter('twice,'), S.TUNING.pauseComma);
  assert.strictEqual(I.pauseAfter('word', true), S.TUNING.pauseLineBreak);
  assert.strictEqual(I.pauseAfter('word'), 0);
});

t('tokenize glues dashes and keeps line breaks', () => {
  const toks = I.tokenize('- Hi there.\n- Hello ♪');
  assert.deepStrictEqual(toks.map((x) => x.text), ['- Hi', 'there.', '- Hello ♪']);
  assert.deepStrictEqual(toks.map((x) => x.br), [false, true, false]);
});

const SRT = `1
00:00:01,000 --> 00:00:04,000
<i>I checked the logs twice,</i>
and the door was never opened.

2
00:00:05,000 --> 00:00:06,000
{\\an8}Run!

3
00:00:10,000 --> 00:00:30,000
Okay.
`;

t('SRT parse + estimate', () => {
  const r = S.parse(SRT);
  assert.strictEqual(r.format, 'srt');
  assert.strictEqual(r.cues.length, 3);
  const c = r.cues[0];
  assert.strictEqual(c.text, 'I checked the logs twice,\nand the door was never opened.');
  assert.strictEqual(c.words[0].at, 1000);                  // first word right at the start
  for (let i = 1; i < c.words.length; i++) assert(c.words[i].at > c.words[i - 1].at);
  assert(c.words[c.words.length - 1].at < 4000);            // last word before the line ends
  assert.strictEqual(r.cues[1].text, 'Run!');               // {\an8} stripped
  // A short word held for 20 s doesn't get stretched: it appears at once.
  assert.strictEqual(r.cues[2].words[0].at, 10000);
});

t('slow speech cap', () => {
  const r = S.parse('1\n00:00:00,000 --> 00:00:20,000\nHello there friend\n');
  const ws = r.cues[0].words;
  assert(ws[2].at - ws[0].at <= 3 * S.TUNING.unitMaxMs + 1, 'words should not be spread over 20 seconds');
});

t('stateAt: word mode, lag, fresh word', () => {
  const r = S.parse(SRT);
  const c = r.cues[0];
  const third = c.words[2].at;
  // Estimated lines get the safety margin on top of the delay setting.
  const M = S.TUNING.estimateMarginMs;
  let st = S.stateAt(r.cues, third + 300 + M, { mode: 'word', lag: 300 });
  assert.strictEqual(st.length, 1);
  assert.deepStrictEqual(st[0].words.map((w) => w.visible).slice(0, 4), [true, true, true, false]);
  assert.strictEqual(st[0].words[2].fresh, true);
  assert.strictEqual(st[0].words[1].fresh, false);
  // Before the line (with lag) nothing shows.
  assert.strictEqual(S.stateAt(r.cues, 1100, { mode: 'word', lag: 300 }).length, 0);
  // Off mode shows everything at once, ignoring lag.
  st = S.stateAt(r.cues, 1000, { mode: 'off', lag: 300 });
  assert(st[0].words.every((w) => w.visible));
});

t('stateAt: chunk mode never runs ahead', () => {
  const r = S.parse(SRT);
  const c = r.cues[0];
  for (let time = c.start; time < c.end + S.TUNING.estimateMarginMs; time += 37) {
    const st = S.stateAt(r.cues, time, { mode: 'chunk', lag: 0 });
    if (!st.length) continue; // still inside the safety margin
    st[0].words.forEach((w, i) => { if (w.visible) assert(c.words[i].at <= time, 'chunk word shown early'); });
  }
});

t('VTT with timestamp map, settings and tags', () => {
  const vtt = `WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000

NOTE this is a comment

1
00:00:01.000 --> 00:00:03.000 align:center line:90%
<v Bob><c.yellow>Where are you?</c></v>

00:04.000 --> 00:04.500
Short form hours
`;
  const r = S.parse(vtt);
  assert.strictEqual(r.format, 'vtt');
  assert.strictEqual(r.meta.mpegts, 900000);
  assert.strictEqual(r.cues.length, 2);
  assert.strictEqual(r.cues[0].text, 'Where are you?');
  assert.strictEqual(r.cues[1].start, 4000);
});

t('VTT karaoke timestamps give real word times', () => {
  const vtt = `WEBVTT

00:00:05.000 --> 00:00:08.000
so<00:00:05.400><c> whoever</c><00:00:06.100><c> took</c><00:00:06.500><c> it</c>
`;
  const c = S.parse(vtt).cues[0];
  assert.deepStrictEqual(c.words.map((w) => w.text), ['so', 'whoever', 'took', 'it']);
  assert.deepStrictEqual(c.words.map((w) => w.at), [5000, 5400, 6100, 6500]);
});

t('TTML (Netflix style ticks, br, spans)', () => {
  const ttml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000">
<body><div>
<p begin="10000000t" end="40000000t" region="r1"><span style="s1">I checked the logs twice,</span><br/>and the door was never opened.</p>
<p begin="00:00:05.000" end="00:00:06.000">Tom &amp; Jerry</p>
<p begin="7s" dur="1500ms">Seconds</p>
</div></body></tt>`;
  const r = S.parse(ttml);
  assert.strictEqual(r.format, 'ttml');
  assert.strictEqual(r.cues.length, 3);
  assert.strictEqual(r.cues[0].start, 1000);
  assert.strictEqual(r.cues[0].end, 4000);
  assert.strictEqual(r.cues[0].text, 'I checked the logs twice,\nand the door was never opened.');
  assert.strictEqual(r.cues[1].text, 'Tom & Jerry');
  assert.strictEqual(r.cues[2].end, 8500);
});

t('YouTube json3: auto captions use real word times, manual captions are estimated', () => {
  const json = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 100000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
      { tStartMs: 1000, dDurationMs: 3000, wWinId: 1, segs: [{ utf8: 'so' }, { utf8: ' whoever', tOffsetMs: 400 }, { utf8: ' took', tOffsetMs: 1100 }] },
      { tStartMs: 2500, dDurationMs: 10, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: 'Manual caption line.' }] }
    ]
  });
  const r = S.parse(json);
  assert.strictEqual(r.format, 'json3');
  assert.strictEqual(r.cues.length, 2);
  assert.deepStrictEqual(r.cues[0].words.map((w) => w.at), [1000, 1400, 2100]);
  assert.strictEqual(r.cues[1].words[0].at, 5000);
  assert(r.cues[1].words[2].at > 5000);
});

t('overlapping cues are stacked in start order', () => {
  const r = S.parse('1\n00:00:01,000 --> 00:00:05,000\nFirst\n\n2\n00:00:02,000 --> 00:00:04,000\nSecond\n');
  const st = S.stateAt(r.cues, 3000, { mode: 'word', lag: 0 });
  assert.deepStrictEqual(st.map((s) => s.words[0].text), ['First', 'Second']);
});

t('ASS export', () => {
  const r = S.parse(SRT);
  const ass = S.toASS(r.cues, { mode: 'word', lag: 300 });
  assert(ass.includes('[Events]'));
  const dialogues = ass.split('\r\n').filter((l) => l.startsWith('Dialogue:'));
  // First event starts at cue start + lag, with only the first word visible.
  assert(dialogues[0].startsWith('Dialogue: 0,0:00:01.60,')); // 300 delay + 300 estimate margin
  assert(dialogues[0].includes('{\\c&H3FB2FF&}I{\\c&HFFFFFF&} {\\alpha&HFF&}checked'));
  assert(dialogues.some((d) => d.includes('\\N')));
  // Events of one cue don't overlap.
  const c0 = dialogues.slice(0, r.cues[0].words.length);
  for (let i = 1; i < c0.length; i++) assert.strictEqual(c0[i].split(',')[1], c0[i - 1].split(',')[2]);
});

t('format sniffing rejects junk', () => {
  assert.strictEqual(S.detectFormat('<html><body>hi</body></html>'), null);
  assert.strictEqual(S.detectFormat('{"foo":1}'), null);
  assert.strictEqual(S.parse('random text'), null);
});



t('YouTube srv3 with word offsets', () => {
  const x = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body><p t="1000" d="3000" w="1"><s>so</s><s t="400"> whoever</s><s t="1100"> took</s></p><p t="5000" d="2000">Manual &amp; line</p></body></timedtext>';
  const r = S.parse(x);
  assert.strictEqual(r.format, 'srv3');
  assert.deepStrictEqual(r.cues[0].words.map((w) => w.at), [1000, 1400, 2100]);
  assert.strictEqual(r.cues[1].text, 'Manual & line');
});

t('lines with real word times skip the safety margin', () => {
  const vtt = 'WEBVTT\n\n00:00:05.000 --> 00:00:08.000\nso<00:00:05.400><c> whoever</c>\n';
  const r = S.parse(vtt);
  const st = S.stateAt(r.cues, 5450, { mode: 'word', lag: 0 });
  assert.deepStrictEqual(st[0].words.map((w) => w.visible), [true, true]);
});

t('Netflix-style rows sent as separate lines become one subtitle, top row first', () => {
  const ttml = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000">
<head><layout><region xml:id="bottom" tts:origin="10% 85%"/><region xml:id="top" tts:origin="10% 78%"/></layout></head>
<body><div>
<p begin="10000000t" end="40000000t" region="bottom">and the door was never opened.</p>
<p begin="10000000t" end="40000000t" region="top">I checked the logs twice,</p>
<p begin="50000000t" end="60000000t" region="bottom">Alone.</p>
</div></body></tt>`;
  const r = S.parse(ttml);
  assert.strictEqual(r.cues.length, 2);
  assert.strictEqual(r.cues[0].text, 'I checked the logs twice,\nand the door was never opened.');
  const ws = r.cues[0].words;
  assert.strictEqual(ws[4].br, true);
  for (let i = 1; i < ws.length; i++) assert(ws[i].at > ws[i - 1].at, 'second row continues after the first');
  // Only one block on screen, revealing in order.
  const st = S.stateAt(r.cues, ws[2].at + S.TUNING.estimateMarginMs, { mode: 'word', lag: 0 });
  assert.strictEqual(st.length, 1);
  assert.deepStrictEqual(st[0].words.map((w) => w.visible).slice(0, 6), [true, true, true, false, false, false]);
});

t('SRT/VTT lines with the same timing merge too; different timing stays separate', () => {
  const r = S.parse('1\n00:00:01,000 --> 00:00:03,000\n- Hi.\n\n2\n00:00:01,020 --> 00:00:03,010\n- Hello there.\n\n3\n00:00:02,000 --> 00:00:04,000\nLater\n');
  assert.strictEqual(r.cues.length, 2);
  assert.strictEqual(r.cues[0].text, '- Hi.\n- Hello there.');
});

t('helper text shows at once and takes no speaking time', () => {
  const r = S.parse('1\n00:00:10,000 --> 00:00:14,000\n[door creaks open]\nJOHN: Who is there? (whispers) Hello?\n');
  const ws = r.cues[0].words;
  const inst = ws.filter((w) => w.inst).map((w) => w.text);
  assert.deepStrictEqual(inst, ['[door', 'creaks', 'open]', 'JOHN:', '(whispers)']);
  assert.strictEqual(ws[0].at, 10000);
  assert.strictEqual(ws.find((w) => w.text === 'Who').at, 10000);  // first spoken word starts the line
  const whisper = ws.find((w) => w.text === '(whispers)'), there = ws.find((w) => w.text === 'there?');
  assert.strictEqual(whisper.at, there.at);                         // appears with the word before it
  const st = S.stateAt(r.cues, 10000 + S.TUNING.estimateMarginMs, { mode: 'word', lag: 0 });
  const vis = st[0].words.filter((w) => w.visible).map((w) => w.text + (w.fresh ? '*' : ''));
  assert.deepStrictEqual(vis, ['[door', 'creaks', 'open]', 'JOHN:', 'Who*']);
  // A line that is only a sound description shows whole immediately.
  const r2 = S.parse('1\n00:00:01,000 --> 00:00:03,000\n[gunshot]\n');
  assert(S.stateAt(r2.cues, 1000 + S.TUNING.estimateMarginMs, { mode: 'word' })[0].words.every((w) => w.visible && !w.fresh));
  // Chunk mode counts spoken words only.
  const st2 = S.stateAt(r.cues, 13990 + S.TUNING.estimateMarginMs, { mode: 'chunk', lag: 0 });
  assert(st2[0].words.every((w) => w.visible));
});

t('words in a parenthesis inside a word are still speech', () => {
  const ws = S.parse('1\n00:00:01,000 --> 00:00:03,000\nThe word(s) matter\n').cues[0].words;
  assert(ws.every((w) => !w.inst));
});


t('a line stays up until its last word has been readable for holdMs', () => {
  const cue = { start: 0, end: 1000, text: 'one two three', explicit: true,
    words: [{ text: 'one', at: 0 }, { text: 'two', at: 500 }, { text: 'three', at: 980 }] };
  const H = S.TUNING.holdMs;
  assert.strictEqual(S.showEnd(cue, 'word'), 980 + H);
  assert.strictEqual(S.stateAt([cue], 980 + H - 10, { mode: 'word' }).length, 1);
  assert.strictEqual(S.stateAt([cue], 980 + H + 10, { mode: 'word' }).length, 0);
  assert.strictEqual(S.showEnd(cue, 'off'), 1000); // normal subtitles keep their own timing
  const ass = S.toASS([cue], { mode: 'word', lag: 0 }).split('\r\n').filter((l) => l.startsWith('Dialogue'));
  assert.ok(ass[ass.length - 1].startsWith('Dialogue: 0,0:00:00.98,0:00:01.78,'));
});

t('a word timed past the line end still shows (never skipped)', () => {
  const cue = { start: 0, end: 1000, text: 'one two', explicit: true,
    words: [{ text: 'one', at: 0 }, { text: 'two', at: 1400 }] };
  const st = S.stateAt([cue], 1100, { mode: 'word' });
  assert.strictEqual(st.length, 1);
  assert.deepStrictEqual(st[0].words.map((w) => w.visible), [true, true]);
  const ass = S.toASS([cue], { mode: 'word', lag: 0 }).split('\r\n').filter((l) => l.startsWith('Dialogue'));
  assert.ok(/two/.test(ass[ass.length - 1]) && !/alpha&HFF&\}two/.test(ass[ass.length - 1]));
});

console.log(`\n${n} tests passed`);
