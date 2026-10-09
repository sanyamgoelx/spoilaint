/*
 * Spoilaint: content script. Finds the playing video, picks the best subtitle source,
 * hides the site's own subtitles and draws the word-by-word version on top.
 *
 * Subtitle sources, best first:
 *   1. network  – the full subtitle file the player downloaded (caught by inject.js)
 *   2. track    – the video's built-in text track (<track> / textTracks)
 *   3. screen   – the site's on-screen subtitles, read as they appear (works almost anywhere,
 *                 but only learns a line when it appears, so timing within the line is estimated)
 */
(function () {
  'use strict';
  if (window.__spoilaintContent) return;
  window.__spoilaintContent = true;

  var S = self.Spoilaint, O = self.SpoilaintOverlay;
  var HOST = location.hostname;
  var IS_TOP = window === window.top;

  // ---------------------------------------------------------------- sites
  var SITES = [
    { id: 'youtube', name: 'YouTube', host: /(^|\.)youtube(-nocookie)?\.com$/, native: ['.ytp-caption-window-container', '.caption-window'] },
    { id: 'netflix', name: 'Netflix', host: /(^|\.)netflix\.com$/, native: ['.player-timedtext'] },
    { id: 'hotstar', name: 'Hotstar', host: /(^|\.)(jio)?hotstar\.com$/, native: [] },
    { id: 'sonyliv', name: 'SonyLIV', host: /(^|\.)sonyliv\.com$/, native: [] },
    { id: 'prime', name: 'Prime Video', host: /(^|\.)(primevideo|amazon)\.(com|in|co\.uk|de)$/, native: ['.atvwebplayersdk-captions-overlay'] }
  ];
  var SITE = SITES.filter(function (s) { return s.host.test(HOST); })[0] || { id: 'generic', name: HOST.replace(/^www\./, ''), native: [] };
  // Caption containers used by common web players, plus loose class-name matches.
  var GENERIC_NATIVE = ['.vjs-text-track-display', '.shaka-text-container', '.jw-captions', '.plyr__captions',
    '.bmpui-ui-subtitle-overlay', '.theoplayer-texttracks', '[class*="subtitle" i]', '[class*="caption" i]', '[class*="timedtext" i]'];
  var NATIVE_SELECTORS = SITE.native.concat(GENERIC_NATIVE);

  // ---------------------------------------------------------------- settings
  var DEFAULTS = { enabled: true, listen: true, mode: 'word', lag: 0, size: 'M', bg: 'shadow', theme: 'amber', highlight: true, disabledSites: [] };
  var settings = Object.assign({}, DEFAULTS);
  function siteOff() { return (settings.disabledSites || []).indexOf(HOST.replace(/^www\./, '')) !== -1; }
  function active() { return settings.enabled && !siteOff(); }

  // ---------------------------------------------------------------- state
  var video = null, overlay = null, listener = null;
  // Whole subtitle files caught from the network, each tagged with the title (episode/video) it belongs
  // to when known. Netflix loads the next episode's file before this one ends: it must not take over.
  var files = [];                                 // { cues, url, at, movie }
  var netFile = null;                             // the one in use
  var newVideoAt = Date.now();                    // last time a new video/episode started
  var segs = { map: Object.create(null), cues: [], at: 0 }; // streamed subtitle segments (HLS/DASH WebVTT)
  var track = { t: null, count: -1, cues: [] };  // the video's own text track we took over
  var ownTracks = new WeakSet();
  var screenCues = [];                            // lines read from the site's on-screen subtitles
  var screenText = '';
  var nativeEls = [];
  var nativeMiss = 0;
  var source = { kind: '', cues: [] };

  // ---------------------------------------------------------------- picking the video
  function pickVideo() {
    var best = null, bestArea = 0;
    var vids = document.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      var r = v.getBoundingClientRect();
      var area = r.width * r.height;
      if (area < 160 * 90) continue;
      if (v.readyState === 0 && !v.currentSrc) continue;
      if (!v.paused) area *= 2;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    if (best !== video) {
      video = best;
      if (overlay) { overlay.destroy(); overlay = null; }
      if (listener) { listener.detach(); listener = null; }
      if (video) {
        overlay = O.create({ anchor: video, getTime: function () { return video ? video.currentTime * 1000 : NaN; }, settings: overlaySettings() });
        overlay.setCues(source.cues);
        video.addEventListener('loadstart', onLoadStart);
        watchPlan(video);
        video.addEventListener('seeking', onSeek);
        // Listen to the dialogue where the site allows it (or to tab audio, if the viewer turned it on).
        attachListener(tabAudio);
      }
    }
  }
  function overlaySettings() {
    return { mode: settings.mode, lag: settings.lag, size: settings.size, bg: settings.bg, theme: settings.theme, highlight: settings.highlight, enabled: active() };
  }

  // ---------------------------------------------------------------- listening
  // Normally we listen to the page's own video. On sites that hide their sound (Netflix etc.) the
  // viewer can turn on "tab audio" in the popup; readings then come from the extension instead.
  var tabAudio = false, tabSilentMs = 0, tabHeard = false;
  var diag = []; // recent readings for the timing report: [videoMs, dB, speech probability]
  var vadState = '', vadGain = null;
  var alignState = '', alignStats = null, planGen = 0, planTimer = 0;
  // Do the subtitles match what's being said? (A dubbed title with the original's subtitles doesn't.)
  // Each finished line gets a score from the speech model: matching ~0.2, other words/language ~0.9.
  // Median of the last 5 lines over 0.6 = mismatch (estimate timing); back under 0.45 = match again.
  var lineScores = [], alignMismatch = false;
  function resetMatch() { lineScores = []; alignMismatch = false; applyBypass(); }
  function judgeLine(gap) {
    lineScores.push(gap); if (lineScores.length > 5) lineScores.shift();
    if (lineScores.length < 3) return;
    var m = lineScores.slice().sort(function (a, b) { return a - b; })[lineScores.length >> 1];
    var was = alignMismatch;
    // Faster playback scores a little worse on matching text (1.5x: median 0.29): raise the bar with speed.
    var sp = Math.max(0, ((video && video.playbackRate) || 1) - 1);
    if (!alignMismatch && m > 0.6 + 0.3 * sp) alignMismatch = true;
    else if (alignMismatch && m < 0.45 + 0.2 * sp) alignMismatch = false;
    if (was !== alignMismatch) {
      applyBypass();
      if (overlay) overlay.toast(alignMismatch ? 'Subtitles don\'t match the audio: estimated timing' : 'Matching words to speech again');
    }
  }
  function mutedNow() { return !!video && (video.muted || video.volume < 0.02); }
  function applyBypass() { if (listener && listener.setBypass) listener.setBypass(aligning() && (alignMismatch || mutedNow())); }

  // Speech model (tab audio): tell it which lines are coming, in wall-clock time. Resent every second
  // (the mapping drifts a little) and at once after a seek, pause, play or speed change.
  var pageAudio = false; // the speech model hears the page's own sound (non-DRM sites), no Sync needed
  function aligning() { return (tabAudio || pageAudio) && alignState === 'on' && !!video && !!listener; }
  function sendPlan(reset) {
    if (!aligning()) return;
    if (reset) planGen++;
    var lines = [];
    if (!video.paused && !video.seeking) {
      var vt = video.currentTime * 1000, rate = video.playbackRate || 1, now = Date.now();
      source.cues.forEach(function (c, ci) {
        if (c.explicit || c.end <= vt - 2000 || c.start >= vt + 10000) return;
        lines.push({ key: planGen + ':' + ci, start: now + (c.start - vt) / rate, end: now + (c.end - vt) / rate,
          words: c.words.map(function (w) { return w.text; }), inst: c.words.map(function (w) { return !!w.inst; }) });
      });
    }
    chrome.runtime.sendMessage({ type: 'align-lines', lines: lines, reset: !!reset }).catch(function () {});
  }
  function onPlanEvent(e) {
    // After a jump, words the speech model placed before count as unheard again.
    if (e && e.type === 'seeking') source.cues.forEach(function (c) { c.words.forEach(function (w) { w.aligned = false; }); });
    sendPlan(true);
  }
  function watchPlan(v) {
    ['seeking', 'seeked', 'pause', 'play', 'ratechange'].forEach(function (ev) { v.addEventListener(ev, onPlanEvent); });
    clearInterval(planTimer);
    planTimer = setInterval(function () { sendPlan(false); }, 1000);
  }
  function onFrame(t, db, prob) { diag.push([Math.round(t), db, prob == null ? null : prob]); if (diag.length > 36000) diag.splice(0, 6000); }
  function attachListener(external) {
    if (listener) { listener.detach(); listener = null; }
    if (!video || !self.SpoilaintListen) return;
    if (!external && settings.listen === false) return;
    try {
      listener = self.SpoilaintListen.attach(video, { getCues: function () { return source.cues; }, external: external, onFrame: onFrame, awaitModel: true,
        onPcm: external ? null : function (pcm, wall) {
          if (!active() || tabAudio || !source.kind) return;
          chrome.runtime.sendMessage({ type: 'page-audio', pcm: pcm, wall: wall }).catch(function () {});
        } });
    } catch (e) { listener = null; }
  }

  // Scrubbing: redraw for the new position, and don't mistake the site reloading its own subtitles
  // for "subtitles switched off".
  var seekQuietUntil = 0;
  function onSeek() {
    if (overlay) overlay.reset();
    nativeMiss = 0;
    seekQuietUntil = Date.now() + 2500;
    // On-screen reading: the line now showing is a new line from this point.
    screenCues = []; screenText = '';
    if (source.kind === 'screen') choose();
  }

  // A new video started (YouTube moves between videos without reloading the page).
  function onLoadStart() {
    var now = Date.now();
    newVideoAt = now;
    // Untagged files from the previous video are dropped; tagged ones are kept (picked by title).
    files = files.filter(function (f) { return f.movie || now - f.at <= 5000; });
    if (now - segs.at > 5000) segs = { map: Object.create(null), cues: [], at: 0 };
    screenCues = []; screenText = '';
    choose();
  }

  // ---------------------------------------------------------------- source 1: network
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.__spoilaint !== 'subs') return;
    var r;
    try { r = S.parse(e.data.text); } catch (err) { return; }
    if (!r || !r.cues.length) return;
    var span = r.cues[r.cues.length - 1].end - r.cues[0].start;
    var whole = r.format !== 'vtt' || r.cues.length >= 25 || span > 10 * 60000;
    if (whole) {
      files = files.filter(function (f) { return f.url !== e.data.url; });
      files.push({ cues: r.cues, url: e.data.url, at: Date.now(), movie: e.data.movie || '' });
      if (files.length > 12) files.shift();
    } else {
      // A piece of a streamed subtitle track: merge it with what we have.
      r.cues.forEach(function (c) {
        var k = c.start + '|' + c.text;
        if (!segs.map[k]) { segs.map[k] = c; segs.cues.push(c); }
      });
      segs.cues.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
      segs.at = Date.now();
    }
    choose();
  });

  // ---------------------------------------------------------------- source 2: text tracks
  function scanTracks() {
    if (!video || !video.textTracks) return;
    var list = video.textTracks, chosen = null;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
      if (t.mode === 'showing') { chosen = t; break; }          // the viewer just picked this one
      if (ownTracks.has(t) && t.mode === 'hidden') chosen = chosen || t; // one we took over earlier
    }
    if (chosen && chosen.mode === 'showing') {
      ownTracks.add(chosen);
      chosen.mode = 'hidden'; // stops the browser drawing it; cues keep loading
    }
    if (chosen !== track.t) track = { t: chosen, count: -1, cues: [] };
    if (!chosen || !chosen.cues) { if (track.cues.length) { track.cues = []; choose(); } return; }
    if (chosen.cues.length !== track.count) {
      track.count = chosen.cues.length;
      var cues = [];
      for (var j = 0; j < chosen.cues.length; j++) {
        var c = chosen.cues[j];
        var text = typeof c.text === 'string' ? c.text : '';
        if (text) cues.push({ start: Math.round(c.startTime * 1000), end: Math.round(c.endTime * 1000), text: cleanCueText(text) });
      }
      track.cues = S.timeCues(cues.filter(function (c) { return c.text; }));
      choose();
    }
  }
  function cleanCueText(t) { return S._internal.cleanText(t); }

  // ---------------------------------------------------------------- source 3 + hiding: the site's on-screen subtitles
  function findNativeEls() {
    if (!video) return [];
    var vr = video.getBoundingClientRect();
    var found = [];
    var seen = new Set();
    for (var i = 0; i < NATIVE_SELECTORS.length; i++) {
      var els;
      try { els = document.querySelectorAll(NATIVE_SELECTORS[i]); } catch (e) { continue; }
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (seen.has(el) || el.closest('spoilaint-overlay')) continue;
        // Skip anything inside an element we already have, and anything that isn't over the video.
        var inside = false;
        for (var k = 0; k < found.length; k++) if (found[k].contains(el)) { inside = true; break; }
        if (inside) continue;
        var r = el.getBoundingClientRect();
        var known = i < SITE.native.length;
        if (!known) {
          if (r.width === 0 && r.height === 0) continue;
          if (r.bottom < vr.top || r.top > vr.bottom || r.right < vr.left || r.left > vr.right) continue;
          if (el.contains(video) || el.querySelector('button, input, a[href], video')) continue;
          if ((el.textContent || '').length > 400) continue;
        }
        seen.add(el);
        found.push(el);
      }
    }
    return found;
  }
  function nativeText() {
    var parts = [];
    for (var i = 0; i < nativeEls.length; i++) {
      var t = (nativeEls[i].innerText || nativeEls[i].textContent || '').trim();
      if (t) parts.push(t);
    }
    return parts.join('\n').trim();
  }

  var placeAt = null, placeSeen = 0;
  function nativeTextBox() {
    var top = Infinity, bottom = -Infinity;
    for (var i = 0; i < nativeEls.length; i++) {
      if (!(nativeEls[i].textContent || '').trim()) continue;
      // Measure the text itself (wrappers can be as big as the whole player).
      var walk = document.createTreeWalker(nativeEls[i], NodeFilter.SHOW_TEXT), node, range = document.createRange();
      while ((node = walk.nextNode())) {
        if (!node.nodeValue.trim()) continue;
        range.selectNodeContents(node);
        var rects = range.getClientRects();
        for (var j = 0; j < rects.length; j++) {
          var r = rects[j];
          if (r.width < 2 || r.height < 2) continue;
          top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
        }
      }
    }
    return isFinite(top) ? { top: top, bottom: bottom } : null;
  }
  // ---------------------------------------------------------------- finding unknown players' subtitles by their text
  // Sites with their own player (Hotstar, SonyLIV...) use class names we can't know in advance. When we
  // have the subtitle file, any element over the video whose text is part of a line showing now is the
  // site's subtitle: hide it (and the container around it that holds only subtitle text). Runs on every
  // page change (MutationObserver), before the browser paints, so the site's line doesn't flash.
  var learned = [];               // site subtitle elements found by text
  var learnScope = null, learnObs = null;
  function normText(t) {
    return String(t || '').toLowerCase().replace(/<[^>]*>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function cueTextsNear(t) {
    var out = [], cues = source.cues || [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      if (c.end < t - 1500) continue;
      if (c.start > t + 1500) break;
      out.push(' ' + normText(c.text) + ' ');
    }
    return out;
  }
  function partOfLine(norm, lines) {
    if (!norm) return true;
    for (var i = 0; i < lines.length; i++) if (lines[i].indexOf(' ' + norm + ' ') !== -1) return true;
    return false;
  }
  function hideNow() { return active() && !!source.kind && !suppressed(); }
  function learnNative(changed) {
    if (!video || !learnScope || !source.kind || source.kind === 'screen') return;
    var lines = cueTextsNear(video.currentTime * 1000);
    if (!lines.length) return;
    var vr = video.getBoundingClientRect();
    var hide = hideNow();
    // Only text that just appeared or changed: static page text (a title that happens to match a
    // line) is never taken for a subtitle.
    var texts = [];
    changed.forEach(function (n) {
      if (n.nodeType === 3) texts.push(n);
      else if (n.nodeType === 1) {
        var w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT), x;
        while ((x = w.nextNode())) texts.push(x);
      }
    });
    for (var i = 0; i < texts.length; i++) {
      var node = texts[i];
      if (!node.isConnected || !learnScope.contains(node)) continue;
      var norm = normText(node.nodeValue);
      if (norm.length < 4 || !partOfLine(norm, lines)) continue;
      var el = node.parentElement;
      if (!el || el.closest('spoilaint-overlay, script, style, button, [role="button"], a[href]')) continue;
      var known = false;
      for (var j = 0; j < learned.length; j++) if (learned[j].contains(el)) { known = true; break; }
      if (known) continue;
      // Climb to the widest container that still holds only subtitle text.
      while (el.parentElement && el.parentElement !== learnScope && !el.parentElement.contains(video) &&
             !el.parentElement.querySelector('button, input, a[href], video, img') &&
             partOfLine(normText(el.parentElement.textContent), lines)) el = el.parentElement;
      var r = el.getBoundingClientRect();
      if (r.bottom < vr.top || r.top > vr.bottom || r.right < vr.left || r.left > vr.right) continue;
      learned.push(el);
      if (hide) el.setAttribute('data-spoilaint-hidden', '');
    }
  }
  function watchForNative() {
    if (!video) return;
    // The player: the widest ancestor of the video that is still about the video's size (subtitle
    // layers sit beside the video's own box), at most 8 levels up.
    var vr = video.getBoundingClientRect(), area = Math.max(1, vr.width * vr.height), scope = video;
    for (var i = 0; i < 8; i++) {
      var p = scope.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      var pr = p.getBoundingClientRect();
      if (pr.width * pr.height > area * 1.6) break;
      scope = p;
    }
    if (scope === video) scope = video.parentElement || video;
    if (scope === learnScope) return;
    if (learnObs) learnObs.disconnect();
    learnScope = scope; learned = [];
    learnObs = new MutationObserver(function (records) {
      var changed = [];
      records.forEach(function (rec) {
        if (rec.type === 'characterData') changed.push(rec.target);
        else for (var k = 0; k < rec.addedNodes.length; k++) changed.push(rec.addedNodes[k]);
      });
      if (changed.length) learnNative(changed); // runs before the next paint, so no flash
    });
    learnObs.observe(scope, { childList: true, subtree: true, characterData: true });
  }

  function scanScreen() {
    if (!video) return;
    watchForNative();
    learned = learned.filter(function (el) { return el.isConnected; });
    nativeEls = findNativeEls();
    for (var li = 0; li < learned.length; li++) {
      var dup = false;
      for (var k = 0; k < nativeEls.length; k++) if (nativeEls[k] === learned[li] || nativeEls[k].contains(learned[li])) { dup = true; break; }
      if (!dup) nativeEls.push(learned[li]);
    }
    var text = nativeText();
    var nowMs = video.currentTime * 1000;
    // Hide the site's subtitles while ours are on screen.
    var hide = active() && !!source.kind && !suppressed();
    for (var i = 0; i < nativeEls.length; i++) {
      if (hide) nativeEls[i].setAttribute('data-spoilaint-hidden', '');
      else nativeEls[i].removeAttribute('data-spoilaint-hidden');
    }
    // Where is the site drawing its subtitles? (Netflix lifts them above on-screen credits or moves
    // them to the top.) Ours follow; our own hiding uses opacity, so the layout is still there.
    if (overlay) {
      var box = text ? nativeTextBox() : null;
      if (box) { placeAt = box; placeSeen = Date.now(); }
      else if (placeAt && Date.now() - placeSeen > 1200) placeAt = null;
      overlay.setPlacement(placeAt);
    }
    // Is the viewer's subtitle setting on? If our line is up but the site shows nothing for a few
    // seconds, they've probably switched subtitles off: step aside until the site shows text again.
    if (source.kind === 'network' && (SITE.native.length || learned.length) && nativeEls.length) {
      var ours = S.stateAt(source.cues, nowMs, { mode: 'off' }).length > 0;
      if (text) nativeMiss = 0; else if (ours && Date.now() > seekQuietUntil) nativeMiss++;
    } else nativeMiss = 0;
    // Source 3: turn on-screen lines into cues as they appear.
    if (text !== screenText) {
      if (screenCues.length) { var last = screenCues[screenCues.length - 1]; if (last.end > nowMs) last.end = Math.max(last.start + 1, nowMs); }
      if (text) {
        // The line just appeared: assume speech starts now. The end is unknown until it disappears.
        var cue = { start: nowMs, end: nowMs + 60000, text: S._internal.cleanText(text) };
        S.timeCues([cue]);
        screenCues.push(cue);
        if (screenCues.length > 40) screenCues.shift();
      }
      screenText = text;
      if (source.kind === 'screen' || !source.kind) choose();
    }
  }
  function suppressed() {
    // Picture-in-picture shows only the video, not our overlay: let the site's own subtitles show there.
    if (document.pictureInPictureElement) return true;
    if (SITE.id === 'youtube') {
      var btn = document.querySelector('.ytp-subtitles-button');
      if (btn && btn.getAttribute('aria-pressed') === 'false') return true;
    }
    return nativeMiss > 20; // ~3 s of our line with nothing from the site
  }

  // ---------------------------------------------------------------- choosing
  // The title playing now: Netflix /watch/<id>, YouTube ?v=<id>. Empty when unknown.
  function currentTitle() {
    var m = /\/watch\/(\d+)/.exec(location.pathname);
    if (m && SITE.id === 'netflix') return m[1];
    if (SITE.id === 'youtube') {
      m = /[?&]v=([\w-]{6,})/.exec(location.search) || /\/(?:shorts|embed|live)\/([\w-]{6,})/.exec(location.pathname);
      if (m) return 'yt:' + m[1];
    }
    return '';
  }
  function pickFile() {
    if (!files.length) return null;
    var id = currentTitle();
    // 1. The latest file for the title playing now (also covers switching subtitle language).
    if (id) for (var i = files.length - 1; i >= 0; i--) if (files[i].movie === id) return files[i];
    // 2. Otherwise the latest file, except that a file for a different title than the one showing
    //    only takes over once a new video or episode has started (Netflix's ids don't always match the URL).
    var latest = files[files.length - 1];
    if (netFile && files.indexOf(netFile) !== -1 && latest !== netFile && latest.movie && netFile.movie &&
        latest.movie !== netFile.movie && latest.at > newVideoAt) return netFile;
    return latest;
  }
  var lastTitle = currentTitle();
  function checkTitle() {
    var id = currentTitle();
    if (id === lastTitle) return;
    lastTitle = id; newVideoAt = Date.now();
    if (overlay) overlay.reset();
    choose();
  }

  function choose() {
    var next;
    netFile = pickFile();
    if (netFile) next = { kind: 'network', cues: netFile.cues };
    else if (segs.cues.length) next = { kind: 'network', cues: segs.cues };
    else if (track.cues.length) next = { kind: 'track', cues: track.cues };
    else if (screenCues.length) next = { kind: 'screen', cues: screenCues };
    else next = { kind: '', cues: [] };
    if (next.kind !== source.kind || next.cues !== source.cues || next.kind === 'screen') {
      var changed = next.cues !== source.cues;
      source = next;
      if (changed && next.kind !== 'screen') resetMatch();
      if (overlay) overlay.setCues(source.cues);
      if (changed) sendPlan(true);
    }
  }

  // ---------------------------------------------------------------- loop
  var STYLE_ID = 'spoilaint-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID) || !document.documentElement) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = '[data-spoilaint-hidden]{opacity:0!important}';
    (document.head || document.documentElement).appendChild(st);
  }
  var tick = 0;
  setInterval(function () {
    tick++;
    if (tick % 7 === 0) { pickVideo(); scanTracks(); ensureStyle(); }
    checkTitle();
    scanScreen();
    if (overlay) overlay.setHidden(!active() || suppressed() || !source.kind);
  }, 150);

  // ---------------------------------------------------------------- fullscreen while listening
  // While Chrome records a tab, the player's fullscreen only fills the tab ("fullscreen within tab").
  // The background page makes the browser window fullscreen to match, and undoes it on exit.
  var sentFullscreen = false;
  function onFullscreen() {
    var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (on ? !tabAudio : !sentFullscreen) return;
    sentFullscreen = on;
    try { chrome.runtime.sendMessage({ type: 'tab-fullscreen', on: on }); } catch (e) {}
  }
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('webkitfullscreenchange', onFullscreen);

  // ---------------------------------------------------------------- keys: Alt+[ and Alt+]
  window.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyB') {
      // Alt+B: "that timing was wrong" - saves a timing report marking this moment, for tuning.
      if (!video || !source.kind) return;
      e.preventDefault(); e.stopPropagation();
      var data = diagnostic();
      data.markedAtMs = Math.round(video.currentTime * 1000);
      data.note = 'Alt+B pressed: timing looked wrong here';
      try {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
        a.download = 'spoilaint-report-' + (data.host || 'site') + '-' + data.savedAt.replace(/[:.]/g, '-') + '.json';
        (document.body || document.documentElement).appendChild(a); a.click(); a.remove();
        if (overlay) overlay.toast('Saved a timing report (Downloads)');
      } catch (err) { if (overlay) overlay.toast('Couldn\'t save: use the Spoilaint menu'); }
      return;
    }
    if (e.code !== 'BracketLeft' && e.code !== 'BracketRight') return;
    if (!video || !active()) return;
    e.preventDefault(); e.stopPropagation();
    var lag = Math.max(-500, Math.min(1500, settings.lag + (e.code === 'BracketRight' ? 100 : -100)));
    chrome.storage.sync.set({ lag: lag });
    settings.lag = lag;
    if (overlay) { overlay.update({ lag: lag }); overlay.toast(lag === 0 ? 'Delay: on time' : 'Delay ' + (lag > 0 ? '+' : '\u2212') + (Math.abs(lag) / 1000).toFixed(1) + ' s'); }
  }, true);

  // ---------------------------------------------------------------- settings + popup
  chrome.storage.sync.get(DEFAULTS, function (s) {
    settings = Object.assign({}, DEFAULTS, s);
    if (overlay) overlay.update(overlaySettings());
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    Object.keys(changes).forEach(function (k) { settings[k] = changes[k].newValue; });
    if (overlay) overlay.update(overlaySettings());
  });

  // Everything needed to tune timing on real audio (popup "Save a timing report", or Alt+B).
  function diagnostic() {
    return {
      spoilaint: chrome.runtime.getManifest().version, site: SITE.name, host: HOST, savedAt: new Date().toISOString(),
      videoMs: Math.round(video.currentTime * 1000), source: source.kind, tabAudio: tabAudio, voiceDetector: vadState,
      speechModel: alignState, speechModelStats: alignStats, lineScores: lineScores, mismatch: alignMismatch, muted: mutedNow(),
      playbackRate: video.playbackRate,
      title: currentTitle(), fileTitle: netFile ? netFile.movie : '', listening: listener ? listener.status() : 'off', voice: listener && listener.voice ? listener.voice() : null, voiceGain: vadGain, settings: settings,
      cues: source.cues.map(function (c) {
        return { start: c.start, end: c.end, text: c.text, explicit: !!c.explicit,
          words: c.words.map(function (w) { return [w.text, w.est != null ? w.est : w.at, w.at, w.inst ? 1 : 0, w.aligned ? 1 : 0]; }) };
      }),
      frames: diag
    };
  }

  // This page may be a new load inside a tab that's already being listened to (next episode, reload).
  try {
    chrome.runtime.sendMessage({ type: 'tab-audio-hello' }, function (r) {
      if (chrome.runtime.lastError || !r || !r.on || tabAudio) return;
      tabAudio = true; tabSilentMs = 0; tabHeard = false;
      if (video) attachListener(true);
    });
  } catch (e) {}

  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (msg && msg.type === 'spoilaint-tab-audio') {
      tabAudio = !!msg.on; tabSilentMs = 0; tabHeard = false;
      if (video) attachListener(tabAudio);
      return;
    }
    if (msg && msg.type === 'spoilaint-audio-frames') {
      if (!tabAudio || !video || !listener || !listener.external) return;
      var now = Date.now(), rate = video.playbackRate || 1;
      if (msg.vad) vadState = msg.vad;
      if (msg.aligner) {
        var was = alignState; alignState = msg.aligner; alignStats = msg.alignStats || null;
        if (listener && listener.setAlignMode) listener.setAlignMode(alignState === 'on');
        if (was !== 'on' && alignState === 'on') sendPlan(true);
      }
      applyBypass(); // muting the player silences tab audio: use the estimate meanwhile
      if (msg.gain != null) vadGain = msg.gain;
      var audible = !video.muted && video.volume > 0.02;
      for (var i = 0; i < msg.frames.length; i++) {
        var wall = msg.frames[i][0], db = msg.frames[i][1];
        if (video.paused) continue;
        listener.pushFrame(db, video.currentTime * 1000 - (now - wall) * rate, msg.frames[i][2]);
        if (db > -100) tabHeard = true;
        else if (audible && !tabHeard) {
          tabSilentMs += 20;
          if (tabSilentMs > 6000) { tabSilentMs = -1e9; chrome.runtime.sendMessage({ type: 'tab-audio-silent' }); }
        }
      }
      return;
    }
    // A word the speech model heard start: show it now (never later than it already would).
    if (msg && msg.type === 'spoilaint-align-reveal') {
      var kp = String(msg.key).split(':');
      if (+kp[0] !== planGen || !video) return;
      var cue = source.cues[+kp[1]], w = cue && cue.words[msg.word];
      if (!w || alignMismatch || mutedNow()) return;
      var rate2 = video.playbackRate || 1, vtNow = video.currentTime * 1000;
      var heardAt = Math.round(vtNow - (Date.now() - msg.wall) * rate2);
      w.aligned = true;
      if (w.at > vtNow) w.at = Math.max(Math.min(w.at, heardAt), cue.start);
      return;
    }
    if (msg && msg.type === 'spoilaint-align-score') {
      var kp2 = String(msg.key).split(':');
      if (+kp2[0] === planGen && msg.frames >= 15) judgeLine(msg.gap);
      return;
    }
    if (msg && msg.type === 'spoilaint-toast') { if (overlay) overlay.toast(msg.text); return; }
    // The speech model is following this page's own sound (no tab capture needed).
    if (msg && msg.type === 'spoilaint-align-state') {
      if (tabAudio) return;
      var wasOn = alignState === 'on' && pageAudio;
      pageAudio = msg.state === 'on'; alignState = msg.state;
      if (listener && listener.setAlignMode) listener.setAlignMode(pageAudio);
      if (pageAudio && !wasOn) sendPlan(true);
      applyBypass();
      return;
    }
    if (msg && msg.type === 'spoilaint-diagnostic') {
      if (!video || !source.kind) return; // a frame with the video answers
      reply(diagnostic());
      return;
    }
    if (!msg || msg.type !== 'spoilaint-status') return;
    var info = {
      site: SITE.name, host: HOST.replace(/^www\./, ''), video: !!video, kind: source.kind,
      lines: source.cues.length, suppressed: suppressed(),
      listening: !!(listener && listener.status() === 'listening'),
      tabAudio: tabAudio, heard: tabHeard, voiceDetector: vadState, speechModel: alignState,
      mismatch: alignMismatch, muted: mutedNow(), pip: !!document.pictureInPictureElement,
      voiceInUse: !!(listener && listener.voice && listener.voice().trusted)
    };
    if (video && source.kind) { reply(info); return; }
    // Frames without subtitles answer a moment later, so a frame that has them wins.
    setTimeout(function () { try { reply(info); } catch (e) {} }, IS_TOP ? 250 : 400);
    return true;
  });
})();
