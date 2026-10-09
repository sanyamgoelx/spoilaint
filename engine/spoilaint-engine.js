/*!
 * Spoilaint timing engine
 * Turns subtitle files into word-by-word reveal timings so a line never shows
 * words the actor hasn't said yet.
 *
 * Works in the browser (window.Spoilaint), in extension content scripts and in Node (require).
 * The VLC script (vlc/spoilaint.lua) is a line-for-line port of the timing part:
 * if you change WEIGHTS or the estimate here, change it there too.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Spoilaint = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Tuning (keep in sync with vlc/spoilaint.lua) ----------------------
  var TUNING = {
    unitMaxMs: 250,      // slowest speech we assume: 250 ms per syllable (~4 syllables a second)
    fill: 0.9,           // spread words over the first 90% of the line's time window
    chunkSize: 3,        // words per chunk in chunk mode
    maxSteps: 60,        // a line with more spoken words than this (a broken file) reveals in groups, so it stays fast
    pauseEllipsis: 2.0,  // "..." or "…"
    pauseStop: 1.2,      // . ! ? । ॥
    pauseComma: 0.8,     // , ; : — –
    pauseLineBreak: 0.4, // a line break inside one subtitle (often a second speaker)
    noLetterWeight: 0.25, // tokens like "♪"
    estimateMarginMs: 300, // extra delay for lines whose timing is only estimated (not matched to speech)
    holdMs: 800          // a line stays up until its last word has been on screen this long (may overlap the next line)
  };

  // ---- Unicode helpers ---------------------------------------------------
  function codepoints(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { out.push(((c - 0xD800) << 10) + (d - 0xDC00) + 0x10000); i++; continue; }
      }
      out.push(c);
    }
    return out;
  }
  function isLatin(cp) {
    return (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) ||
      (cp >= 0xC0 && cp <= 0x24F && cp !== 0xD7 && cp !== 0xF7);
  }
  function isDigit(cp) { return cp >= 48 && cp <= 57; }
  function isDevanagari(cp) { return cp >= 0x900 && cp <= 0x97F && cp !== 0x964 && cp !== 0x965; }
  function isCJK(cp) {
    return (cp >= 0x3040 && cp <= 0x30FF) || (cp >= 0x3400 && cp <= 0x9FFF) || (cp >= 0xAC00 && cp <= 0xD7AF);
  }
  function isOtherLetter(cp) {
    // Greek, Cyrillic, Arabic, other scripts. Excludes general punctuation and symbols.
    if (cp < 0x370) return false;
    if (cp >= 0x2000 && cp <= 0x2BFF) return false; // punctuation, arrows, symbols
    if (cp >= 0x3000 && cp <= 0x303F) return false; // CJK punctuation
    if (cp >= 0xFE30 && cp <= 0xFE4F) return false;
    if (cp >= 0xFF00 && cp <= 0xFF0F) return false;
    if (cp >= 0x1F000) return false;                 // emoji
    return !isDevanagari(cp) && !(cp >= 0x900 && cp <= 0x97F);
  }
  function isWordChar(cp) { return isLatin(cp) || isDigit(cp) || isDevanagari(cp) || isOtherLetter(cp); }
  var LATIN_VOWELS = 'aeiouyAEIOUYàáâãäåæèéêëìíîïòóôõöøùúûüýÿÀÁÂÃÄÅÆÈÉÊËÌÍÎÏÒÓÔÕÖØÙÚÛÜÝ';
  function isLatinVowel(cp) { return LATIN_VOWELS.indexOf(String.fromCharCode(cp)) !== -1; }

  // How long a word takes to say, in "syllables".
  function weightOf(token) {
    var cps = codepoints(token);
    var latinGroups = 0, inVowel = false, latinLetters = 0, latinTail = '';
    var digits = 0, deva = 0, devaVirama = 0, hasDeva = false, cjk = 0, other = 0, letters = 0;
    for (var i = 0; i < cps.length; i++) {
      var cp = cps[i];
      if (isLatin(cp)) {
        letters++; latinLetters++;
        latinTail = (latinTail + (cp < 128 ? String.fromCharCode(cp) : 'x')).slice(-3);
        if (isLatinVowel(cp)) { if (!inVowel) latinGroups++; inVowel = true; } else inVowel = false;
        continue;
      }
      inVowel = false;
      if (isDigit(cp)) { digits++; letters++; }
      else if (isDevanagari(cp)) {
        hasDeva = true; letters++;
        if ((cp >= 0x915 && cp <= 0x939) || (cp >= 0x958 && cp <= 0x95F) || (cp >= 0x904 && cp <= 0x914)) deva++;
        else if (cp === 0x94D) devaVirama++;
      }
      else if (isCJK(cp)) { cjk++; letters++; }
      else if (isOtherLetter(cp)) { other++; letters++; }
    }
    // Silent endings: "time" (1), "checked" (1) but not "wanted" (2).
    if (latinLetters > 3 && latinGroups > 1) {
      var tail = latinTail.toLowerCase();
      if (/[^aeiouy]e$/.test(tail) && !/le$/.test(tail)) latinGroups--;
      else if (/[^aeiouytd]ed$/.test(tail)) latinGroups--;
    }
    if (latinLetters > 0 && latinGroups === 0) latinGroups = 1;
    var w = latinGroups + digits + cjk + Math.ceil(other / 3);
    if (hasDeva) w += Math.max(1, deva - devaVirama);
    if (letters === 0) return TUNING.noLetterWeight;
    return Math.max(1, w);
  }

  // Pause after a word, in syllables.
  function pauseAfter(token, br) {
    var t = token.replace(/["'”’)\]»]+$/, '');
    if (/(\.\.\.|…)$/.test(t)) return TUNING.pauseEllipsis;
    if (/[.!?।॥]$/.test(t)) return TUNING.pauseStop;
    if (/([,;:—–]|--)$/.test(t)) return TUNING.pauseComma;
    if (br) return TUNING.pauseLineBreak;
    return 0;
  }

  function hasWordChar(s) {
    var cps = codepoints(s);
    for (var i = 0; i < cps.length; i++) if (isWordChar(cps[i])) return true;
    return false;
  }

  // ---- Text cleaning -----------------------------------------------------
  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, e) {
      if (e[0] === '#') {
        var n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(n) && n > 0 && n <= 0x10FFFF && (n < 0xD800 || n > 0xDFFF) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES.hasOwnProperty(e) ? ENTITIES[e] : m;
    });
  }
  function cleanText(s) {
    return decodeEntities(
      s.replace(/\r/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\{\\[^}]*\}/g, '')     // ASS overrides like {\an8}
        .replace(/<[^>]+>/g, '')          // <i>, <font>, <c.yellow>, <v Bob>
    ).replace(/ /g, ' ').replace(/\\N/g, '\n')
      .split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); })
      .filter(function (l) { return l.length; }).join('\n');
  }

  // ---- Tokenizing --------------------------------------------------------
  // items: [{text, at?} | {nl: true}] -> words [{text, br, at?}]
  // Punctuation-only bits ("-", "♪") are glued to the next word on the same line
  // (or to the previous one at the end of a line). br = a line break follows this word.
  function tokenizeItems(items) {
    var out = [], line = [], pending = null;
    function flushLine(isBreak) {
      if (pending) {
        if (line.length) line[line.length - 1].text += ' ' + pending.text;
        else line.push({ text: pending.text, br: false, at: pending.at });
        pending = null;
      }
      if (line.length && isBreak) line[line.length - 1].br = true;
      out = out.concat(line);
      line = [];
    }
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.nl) { flushLine(true); continue; }
      if (!hasWordChar(it.text)) {
        if (pending) pending.text += ' ' + it.text; else pending = { text: it.text, at: it.at };
        continue;
      }
      var w = { text: pending ? pending.text + ' ' + it.text : it.text, br: false, at: pending && pending.at != null ? pending.at : it.at };
      pending = null;
      line.push(w);
    }
    flushLine(false);
    if (out.length) out[out.length - 1].br = false;
    return out;
  }
  function itemsFromText(text, at) {
    var items = [];
    var lines = text.replace(/\u00A0/g, ' ').split('\n');
    for (var li = 0; li < lines.length; li++) {
      if (li > 0) items.push({ nl: true });
      var parts = lines[li].split(/[ \t]+/);
      for (var pi = 0; pi < parts.length; pi++) if (parts[pi]) items.push({ text: parts[pi], at: at });
    }
    return items;
  }
  function tokenize(text) { return markInstant(tokenizeItems(itemsFromText(text))); }

  // ---- Helper text: [door creaks], (laughs), JOHN: ---------------------------------
  // Sound descriptions and speaker labels aren't speech. They appear at once (with the spoken word
  // before them, or when the line appears), take no speaking time and are never coloured as newest.
  var LABEL_RE = /^[A-Z0-9][A-Z0-9 .'\u2019&-]*:$/;
  function markInstant(words) {
    var depth = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var core = w.text.replace(/^[\s\-\u2013\u2014\u266A\u266B]+/, '');
      var inst = depth > 0 || /^[\[(]/.test(core);
      var opens = (w.text.match(/[\[(]/g) || []).length, closes = (w.text.match(/[\])]/g) || []).length;
      depth = Math.max(0, depth + opens - closes);
      var lineStart = i === 0 || words[i - 1].br;
      if (lineStart && core.length >= 3 && /[A-Z]/.test(core) && LABEL_RE.test(core)) inst = true;
      w.inst = inst;
    }
    return words;
  }
  // Helper text appears together with the spoken word before it (or when the line appears).
  function placeInstant(words, start) {
    var last = start;
    for (var i = 0; i < words.length; i++) {
      if (words[i].inst) words[i].at = last; else last = words[i].at;
    }
    return words;
  }

  // ---- Time parsing ------------------------------------------------------
  function clockToMs(s) {
    // 01:02:03,456 | 01:02:03.456 | 02:03.456
    var m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d*))?$/.exec(s.trim());
    if (!m) return NaN;
    var ms = m[4] ? parseInt((m[4] + '00').slice(0, 3), 10) : 0;
    if (m[1] && m[1].length > 2) return NaN;  // 100+ hours: a broken time, not a film
    return ((parseInt(m[1] || '0', 10) * 60 + parseInt(m[2], 10)) * 60 + parseInt(m[3], 10)) * 1000 + ms;
  }

  // ---- SRT ---------------------------------------------------------------
  function parseSRT(text) {
    var cues = [];
    var blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
    for (var b = 0; b < blocks.length; b++) {
      var lines = blocks[b].split('\n');
      var i = 0;
      while (i < lines.length && lines[i].indexOf('-->') === -1) i++;
      if (i >= lines.length) continue;
      var m = /([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[i]);
      if (!m) continue;
      var start = clockToMs(m[1]), end = clockToMs(m[2]);
      var rawBody = lines.slice(i + 1).join('\n');
      var body = cleanText(rawBody);
      if (!isFinite(start) || !isFinite(end) || !body) continue;
      cues.push({ start: start, end: Math.max(end, start + 1), text: body, y: /\{\\an[789]\}/.test(rawBody) ? 0 : 100 });
    }
    return cues;
  }

  // ---- WebVTT ------------------------------------------------------------
  function parseVTT(text) {
    var cues = [];
    var meta = {};
    var src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    var map = /X-TIMESTAMP-MAP=([^\n]+)/.exec(src);
    if (map) {
      var mp = /MPEGTS:(\d+)/.exec(map[1]), lc = /LOCAL:([\d:.]+)/.exec(map[1]);
      meta.mpegts = mp ? parseInt(mp[1], 10) : 0;
      meta.local = lc ? clockToMs(lc[1]) : 0;
    }
    var blocks = src.split(/\n[ \t]*\n/);
    for (var b = 0; b < blocks.length; b++) {
      var lines = blocks[b].split('\n');
      var i = 0;
      while (i < lines.length && lines[i].indexOf('-->') === -1) i++;
      if (i >= lines.length) continue;
      if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
      var m = /([\d:.]+)\s*-->\s*([\d:.]+)/.exec(lines[i]);
      if (!m) continue;
      var start = clockToMs(m[1]), end = clockToMs(m[2]);
      var raw = lines.slice(i + 1).join('\n');
      var cue = buildTimedCue(start, end, raw);
      if (cue) {
        var ln = /\bline:(-?[\d.]+)(%?)/.exec(lines[i]);
        if (ln) cue.y = ln[2] ? parseFloat(ln[1]) : (parseFloat(ln[1]) < 0 ? 1000 + parseFloat(ln[1]) : parseFloat(ln[1]) * 5);
        cues.push(cue);
      }
    }
    return { cues: cues, meta: meta };
  }

  // Splits raw cue text on inline <00:00:01.500> karaoke timestamps (YouTube auto-captions use these).
  function buildTimedCue(start, end, raw) {
    if (!isFinite(start) || !isFinite(end)) return null;
    var re = /<(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})>/g;
    if (!re.test(raw)) {
      var body = cleanText(raw);
      return body ? { start: start, end: Math.max(end, start + 1), text: body } : null;
    }
    re.lastIndex = 0;
    var pieces = [], last = 0, at = start, mm;
    while ((mm = re.exec(raw))) {
      pieces.push({ text: raw.slice(last, mm.index), at: at });
      at = clockToMs(mm[1]);
      last = re.lastIndex;
    }
    pieces.push({ text: raw.slice(last), at: at });
    return cueFromPieces(start, end, pieces);
  }

  // pieces: [{text, at}] in order (karaoke timestamps, YouTube segments). Produces a cue with real word times.
  function cueFromPieces(start, end, pieces) {
    var items = [];
    for (var p = 0; p < pieces.length; p++) {
      var t = decodeEntities(pieces[p].text.replace(/\r/g, '').replace(/<br\s*\/?>/gi, '\n')
        .replace(/\{\\[^}]*\}/g, '').replace(/<[^>]+>/g, ''));
      items = items.concat(itemsFromText(t, Math.max(start, Math.min(end, pieces[p].at))));
    }
    // Collapse empty lines: drop leading/trailing/double line breaks.
    var clean = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].nl && (!clean.length || clean[clean.length - 1].nl)) continue;
      clean.push(items[i]);
    }
    while (clean.length && clean[clean.length - 1].nl) clean.pop();
    var words = markInstant(tokenizeItems(clean));
    if (!words.length) return null;
    placeInstant(words, start);
    var text = words.map(function (w) { return w.text + (w.br ? '\n' : ' '); }).join('').trim();
    return { start: start, end: Math.max(end, start + 1), text: text, words: words, explicit: true };
  }

  // ---- TTML / DFXP (Netflix, many players) --------------------------------
  function parseTTML(text) {
    var tickRate = 10000000, frameRate = 30, frameMul = 1;
    var tt = /<tt\b[^>]*>/i.exec(text);
    if (tt) {
      var tr = /tickRate="(\d+)"/i.exec(tt[0]); if (tr) tickRate = parseInt(tr[1], 10);
      var fr = /frameRate="(\d+)"/i.exec(tt[0]); if (fr) frameRate = parseInt(fr[1], 10);
      var fm = /frameRateMultiplier="(\d+)\s+(\d+)"/i.exec(tt[0]); if (fm) frameMul = parseInt(fm[1], 10) / parseInt(fm[2], 10);
    }
    function t2ms(v) {
      if (!v) return NaN;
      v = v.trim();
      var m;
      if ((m = /^([\d.]+)t$/.exec(v))) return parseFloat(m[1]) / tickRate * 1000;
      if ((m = /^([\d.]+)ms$/.exec(v))) return parseFloat(m[1]);
      if ((m = /^([\d.]+)s$/.exec(v))) return parseFloat(m[1]) * 1000;
      if ((m = /^([\d.]+)m$/.exec(v))) return parseFloat(m[1]) * 60000;
      if ((m = /^([\d.]+)h$/.exec(v))) return parseFloat(m[1]) * 3600000;
      if ((m = /^([\d.]+)f$/.exec(v))) return parseFloat(m[1]) / (frameRate * frameMul) * 1000;
      if ((m = /^(\d+):(\d{2}):(\d{2}):(\d+(?:\.\d+)?)$/.exec(v)))
        return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + (+m[4]) / (frameRate * frameMul) * 1000;
      return clockToMs(v);
    }
    // Vertical position of each region (tts:origin="x y"), to order rows top to bottom.
    var regionY = {}, rm, rre = /<(?:\w+:)?region\b([^>]*)>/gi;
    function originY(attrs) {
      var o = /\borigin="\s*[-\d.]+\w*%?\s+([-\d.]+)/.exec(attrs);
      return o ? parseFloat(o[1]) : undefined;
    }
    while ((rm = rre.exec(text))) {
      var rid = /\bxml:id="([^"]+)"/.exec(rm[1]) || /\bid="([^"]+)"/.exec(rm[1]);
      if (rid) regionY[rid[1]] = originY(rm[1]);
    }
    var cues = [];
    var re = /<(?:\w+:)?p\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?p>/gi, m;
    while ((m = re.exec(text))) {
      var attrs = m[1];
      var b = /\bbegin="([^"]+)"/.exec(attrs), e = /\bend="([^"]+)"/.exec(attrs), d = /\bdur="([^"]+)"/.exec(attrs);
      var start = b ? t2ms(b[1]) : NaN;
      var end = e ? t2ms(e[1]) : (d ? start + t2ms(d[1]) : NaN);
      var body = cleanText(m[2].replace(/<(?:\w+:)?br\s*\/?>/gi, '\n'));
      if (!isFinite(start) || !isFinite(end) || !body) continue;
      var reg = /\bregion="([^"]+)"/.exec(attrs);
      var y = originY(attrs);
      if (y === undefined && reg) y = regionY[reg[1]];
      cues.push({ start: Math.round(start), end: Math.round(Math.max(end, start + 1)), text: body, y: y });
    }
    cues.sort(function (a, b2) { return a.start - b2.start; });
    return cues;
  }

  // ---- YouTube json3 -------------------------------------------------------
  function parseJSON3(data) {
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return []; } }
    var cues = [];
    var events = (data && Array.isArray(data.events)) ? data.events : [];
    var num = function (x) { return typeof x === 'number' && isFinite(x) && x >= 0 ? x : 0; };
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev || !Array.isArray(ev.segs) || ev.aAppend) continue;
      ev.segs = ev.segs.filter(function (s) { return s && typeof s === 'object'; });
      var start = num(ev.tStartMs), end = start + num(ev.dDurationMs);
      var explicit = ev.segs.length > 1 && ev.segs.some(function (s) { return s.tOffsetMs != null; });
      if (explicit) {
        var pieces = ev.segs.map(function (s) { return { text: typeof s.utf8 === 'string' ? s.utf8 : '', at: start + num(s.tOffsetMs) }; });
        var cue = cueFromPieces(start, end, pieces);
        if (cue) cues.push(cue);
      } else {
        var body = cleanText(ev.segs.map(function (s) { return typeof s.utf8 === 'string' ? s.utf8 : ''; }).join(''));
        if (body) cues.push({ start: start, end: Math.max(end, start + 1), text: body });
      }
    }
    return cues;
  }

  // ---- YouTube srv3 (XML: <timedtext><body><p t="ms" d="ms"><s t="ms">word</s>...) ----
  function parseSRV3(text) {
    var cues = [];
    var re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi, m;
    while ((m = re.exec(text))) {
      var t = /\bt="(\d+)"/.exec(m[1]), d = /\bd="(\d+)"/.exec(m[1]);
      if (!t) continue;
      var start = +t[1], end = start + (d ? +d[1] : 2000);
      var segs = [], sm, sre = /<s\b([^>]*)>([\s\S]*?)<\/s>/gi;
      while ((sm = sre.exec(m[2]))) {
        var st = /\bt="(\d+)"/.exec(sm[1]);
        segs.push({ text: sm[2], at: start + (st ? +st[1] : 0) });
      }
      var cue;
      if (segs.length > 1) cue = cueFromPieces(start, end, segs);
      else {
        var body = cleanText(m[2]);
        cue = body ? { start: start, end: Math.max(end, start + 1), text: body } : null;
      }
      if (cue) cues.push(cue);
    }
    return cues;
  }

  // ---- Format sniffing -----------------------------------------------------
  function detectFormat(text) {
    var head = text.replace(/^﻿/, '').slice(0, 600).trimStart();
    if (/^WEBVTT/.test(head)) return 'vtt';
    if (head[0] === '{' && /"events"\s*:/.test(text.slice(0, 5000))) return 'json3';
    if (/<timedtext[\s>]/i.test(text.slice(0, 2000))) return 'srv3';
    if (/<tt[\s>]|<(\w+:)?tt[\s>]/i.test(head) || /^<\?xml[\s\S]*<(\w+:)?tt\b/i.test(text.slice(0, 2000))) return 'ttml';
    if (/^\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head.replace(/\r/g, ''))) return 'srt';
    if (/^\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt';
    return null;
  }

  // Parses any supported format. Returns {format, cues, meta} or null.
  function parse(text, hint) {
    var fmt = hint || detectFormat(text);
    if (!fmt) return null;
    var cues, meta = {};
    if (fmt === 'srt') cues = parseSRT(text);
    else if (fmt === 'vtt') { var v = parseVTT(text); cues = v.cues; meta = v.meta; }
    else if (fmt === 'ttml') cues = parseTTML(text);
    else if (fmt === 'json3') cues = parseJSON3(text);
    else if (fmt === 'srv3') cues = parseSRV3(text);
    else return null;
    return { format: fmt, cues: timeCues(cues), meta: meta };
  }

  // ---- The estimate ------------------------------------------------------------
  function estimateWords(cue) {
    var toks = tokenize(cue.text);
    if (!toks.length) return [];
    var w = toks.map(function (t) { return t.inst ? 0 : weightOf(t.text); });
    var p = toks.map(function (t) { return t.inst ? 0 : pauseAfter(t.text, t.br); });
    var sum = 0;
    for (var i = 0; i < toks.length; i++) sum += w[i] + (i < toks.length - 1 ? p[i] : 0);
    var dur = cue.end - cue.start;
    var unit = sum > 0 ? Math.min(dur * TUNING.fill / sum, TUNING.unitMaxMs) : 0;
    var acc = 0;
    var out = toks.map(function (t, i) {
      var at = cue.start + Math.round(acc * unit);
      acc += w[i] + p[i];
      return { text: t.text, br: t.br, at: at, inst: !!t.inst };
    });
    return placeInstant(out, cue.start);
  }

  // Lines that appear and disappear together are one subtitle shown on two rows (Netflix sends each
  // row separately). Join them, top row first, so they reveal as one sentence.
  var MERGE_MS = 40;
  function mergeSameTime(cues) {
    var out = [], group = [];
    function flush() {
      if (!group.length) return;
      if (group.length === 1) { out.push(group[0]); group = []; return; }
      var haveY = group.every(function (c) { return typeof c.y === 'number'; });
      group.sort(function (a, b) { return haveY && a.y !== b.y ? a.y - b.y : a._i - b._i; });
      var merged = {
        start: Math.min.apply(null, group.map(function (c) { return c.start; })),
        end: Math.max.apply(null, group.map(function (c) { return c.end; })),
        text: group.map(function (c) { return c.text; }).join('\n')
      };
      if (group.every(function (c) { return c.words && c.words.length; })) {
        merged.words = [];
        group.forEach(function (c, gi) {
          c.words.forEach(function (w, wi) {
            var copy = Object.assign({}, w);
            if (wi === c.words.length - 1 && gi < group.length - 1) copy.br = true;
            merged.words.push(copy);
          });
        });
        merged.explicit = group.every(function (c) { return c.explicit; });
      }
      out.push(merged);
      group = [];
    }
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      if (group.length && !(Math.abs(group[0].start - c.start) <= MERGE_MS && Math.abs(group[0].end - c.end) <= MERGE_MS)) flush();
      group.push(c);
    }
    flush();
    return out;
  }

  function timeCues(cues) {
    for (var i = 0; i < cues.length; i++) cues[i]._i = i;
    cues.sort(function (a, b) { return a.start - b.start || a.end - b.end || a._i - b._i; });
    cues = mergeSameTime(cues);
    for (var j = 0; j < cues.length; j++) {
      if (!cues[j].words) cues[j].words = estimateWords(cues[j]);
      delete cues[j]._i;
    }
    return cues;
  }

  // ---- Reveal state ----------------------------------------------------------
  // opts: {mode: 'word'|'chunk'|'off', lag: ms}
  // Returns the subtitles to draw at time t (ms):
  // [{key, words: [{text, br, visible, fresh}]}]
  function stateAt(cues, t, opts) {
    opts = opts || {};
    var mode = opts.mode || 'word';
    var lag = mode === 'off' ? 0 : (opts.lag || 0);
    var margin = mode === 'off' ? 0 : TUNING.estimateMarginMs;
    var out = [];
    // Cues are sorted by start; binary search for the last cue starting at or before the time.
    var tp0 = t - lag;
    var lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (cues[mid].start <= tp0) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    for (var i = idx; i >= 0 && i > idx - 40; i--) {
      var c = cues[i];
      // Lines with real word times (speech-matched, karaoke, YouTube auto-captions) need no safety margin.
      var tp = tp0 - (c.explicit || c.synced || c.live ? 0 : margin);
      if (tp >= c.start && tp < showEnd(c, mode)) out.unshift(revealCue(c, i, tp, mode));
    }
    return out;
  }

  // When a word shows. Nothing may land after the line's end: a word timed past it (speech matching,
  // a site line that vanished early) shows when the line ends, then the hold keeps it readable.
  function wordAt(cue, w) { return Math.min(w.at, cue.end); }
  // When a line leaves the screen: its end, or later so the last word stays up for holdMs.
  function showEnd(cue, mode) {
    if (mode === 'off') return cue.end;
    var last = cue.start;
    for (var i = 0; i < cue.words.length; i++) if (!cue.words[i].inst) last = Math.max(last, wordAt(cue, cue.words[i]));
    return Math.max(cue.end, last + TUNING.holdMs);
  }

  // Spoken words reveal by time (or in chunks of spoken words); helper text follows the spoken word
  // before it. Only spoken words are ever "fresh" (coloured as newest).
  function groupSize(n, mode) { return Math.max(mode === 'chunk' ? TUNING.chunkSize : 1, Math.ceil(n / TUNING.maxSteps)); }
  function revealCue(cue, key, tp, mode) {
    var ws = cue.words, n = ws.length;
    var spoken = [];
    for (var i = 0; i < n; i++) if (!ws[i].inst) spoken.push(i);
    var size = groupSize(spoken.length, mode);
    var vis = new Array(n), lastPos = -1;
    for (var k = 0; k < spoken.length; k++) {
      var on;
      if (mode === 'off') on = true;
      else if (size > 1) on = tp >= wordAt(cue, ws[spoken[Math.min(spoken.length - 1, Math.floor(k / size) * size + size - 1)]]);
      else on = tp >= wordAt(cue, ws[spoken[k]]);
      vis[spoken[k]] = on;
      if (on) lastPos = k;
    }
    var prevSpoken = -1;
    for (var j = 0; j < n; j++) {
      if (!ws[j].inst) { prevSpoken = j; continue; }
      vis[j] = prevSpoken === -1 ? (mode === 'off' || tp >= cue.start) : vis[prevSpoken];
    }
    var fresh = {};
    if (mode !== 'off' && lastPos >= 0) {
      for (var q = Math.floor(lastPos / size) * size; q <= lastPos; q++) fresh[spoken[q]] = true;
    }
    var words = ws.map(function (w, i) {
      return { text: w.text, br: w.br, visible: !!vis[i], fresh: !!fresh[i], inst: !!w.inst };
    });
    return { key: key, start: cue.start, end: cue.end, words: words };
  }

  // Times at which the visible state of a cue changes (for ASS export and render scheduling).
  function revealSteps(cue, mode) {
    var ws = cue.words, steps = [];
    if (mode === 'off') return [cue.start];
    var spoken = [];
    for (var i = 0; i < ws.length; i++) if (!ws[i].inst) spoken.push(i);
    var size = groupSize(spoken.length, mode);
    for (var k = 0; k < spoken.length; k++) {
      var at = wordAt(cue, size > 1 ? ws[spoken[Math.min(spoken.length - 1, Math.floor(k / size) * size + size - 1)]] : ws[spoken[k]]);
      if (!steps.length || steps[steps.length - 1] !== at) steps.push(at);
    }
    if (!steps.length || steps[0] > cue.start) steps.unshift(cue.start);
    return steps;
  }

  // ---- ASS export (same output as the VLC script) ----------------------------
  function assTime(ms) {
    ms = Math.max(0, Math.round(ms));
    var cs = Math.floor(ms / 10), h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60,
      s = Math.floor(cs / 100) % 60, c = cs % 100;
    return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + (c < 10 ? '0' : '') + c;
  }
  function assEscape(s) { return s.replace(/\\/g, '⧵').replace(/\{/g, '(').replace(/\}/g, ')'); }
  function hexToAssColour(hex) {
    var h = hex.replace('#', '');
    return '&H' + (h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toUpperCase() + '&';
  }

  // opts: {mode, lag, font, size, box, highlight, accent}
  function toASS(cues, opts) {
    opts = opts || {};
    var mode = opts.mode || 'word', lag = opts.lag == null ? 0 : opts.lag;
    var font = opts.font || 'Segoe UI', size = opts.size || 64;
    var accent = hexToAssColour(opts.accent || '#FFB23F');
    var highlight = opts.highlight !== false;
    var box = !!opts.box;
    var lines = [
      '[Script Info]',
      '; Made by Spoilaint: words appear as they are spoken',
      'ScriptType: v4.00+',
      'PlayResX: 1920',
      'PlayResY: 1080',
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Default,' + font + ',' + size + ',&H00FFFFFF,&H00FFFFFF,' + (box ? '&H40000000' : '&H00000000') + ',&H80000000,-1,0,0,0,100,100,0,0,' + (box ? '3,8,0' : '1,3,1.5') + ',2,120,120,70,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
    ];
    var baseLag = lag;
    for (var ci = 0; ci < cues.length; ci++) {
      var cue = cues[ci];
      lag = baseLag + ((cue.explicit || cue.synced || mode === 'off') ? 0 : TUNING.estimateMarginMs);
      var steps = revealSteps(cue, mode);
      for (var si = 0; si < steps.length; si++) {
        var from = steps[si], to = si + 1 < steps.length ? steps[si + 1] : showEnd(cue, mode);
        if (to <= from) continue;
        var st = revealCue(cue, ci, from, mode);
        var text = '';
        for (var wi = 0; wi < st.words.length; wi++) {
          var w = st.words[wi];
          var t = assEscape(w.text);
          if (!w.visible) t = '{\\alpha&HFF&}' + t + '{\\alpha&H00&}';
          else if (highlight && w.fresh) t = '{\\c' + accent + '}' + t + '{\\c&HFFFFFF&}';
          text += t + (w.br ? '\\N' : (wi < st.words.length - 1 ? ' ' : ''));
        }
        lines.push('Dialogue: 0,' + assTime(from + lag) + ',' + assTime(to + lag) + ',Default,,0,0,0,,' + text);
      }
    }
    return lines.join('\r\n') + '\r\n';
  }

  return {
    TUNING: TUNING,
    parse: parse, detectFormat: detectFormat,
    parseSRT: function (t) { return timeCues(parseSRT(t)); },
    parseVTT: function (t) { var v = parseVTT(t); v.cues = timeCues(v.cues); return v; },
    parseTTML: function (t) { return timeCues(parseTTML(t)); },
    parseJSON3: function (t) { return timeCues(parseJSON3(t)); },
    timeCues: timeCues, stateAt: stateAt, showEnd: showEnd, revealSteps: revealSteps, toASS: toASS,
    _internal: { weightOf: weightOf, pauseAfter: pauseAfter, pauseAfter: pauseAfter, tokenize: tokenize, cleanText: cleanText, clockToMs: clockToMs, estimateWords: estimateWords }
  };
});
