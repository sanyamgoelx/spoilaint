(function () {
  var $ = function (id) { return document.getElementById(id); };
  var video = $('video'), fake = $('fake'), drop = $('drop'), screen = $('screen');
  var settings = { mode: 'word', lag: 0, size: 'M', bg: 'shadow', theme: 'amber', highlight: true };
  var cues = [], subName = '', listener = null;
  window.__spoilaintCues = function () { return cues; };
  var useVideo = false;
  // Fake clock for subtitle-only mode.
  var clock = { t: 0, playing: false, last: 0, duration: 0 };

  var SAMPLE = '1\n00:00:00,600 --> 00:00:03,700\nI checked the logs twice,\nand the door was never opened.\n\n2\n00:00:04,300 --> 00:00:06,900\nSo whoever took it... was already inside.\n\n3\n00:00:07,500 --> 00:00:09,000\nThen it\'s one of us.\n\n4\n00:00:09,800 --> 00:00:12,200\nमुझे पता था... तुम ही हो।\n';

  function now() {
    if (useVideo) return video.currentTime * 1000;
    if (clock.playing) {
      var n = performance.now();
      clock.t += n - clock.last; clock.last = n;
      if (clock.t >= clock.duration) { clock.t = clock.duration; clock.playing = false; syncPlayIcon(); }
    }
    return clock.t;
  }
  var overlay = SpoilaintOverlay.create({ anchor: screen, getTime: now, settings: settings });

  function decode(buf) {
    var b = new Uint8Array(buf);
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b);
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
    catch (e) { return new TextDecoder('windows-1252').decode(b); }
  }

  function loadSubtitle(text, name) {
    var r = Spoilaint.parse(text);
    if (!r || !r.cues.length) { status(false, 'Couldn\'t read ' + name + ' as subtitles'); return false; }
    cues = r.cues; subName = name;
    overlay.setCues(cues);
    clock.duration = cues[cues.length - 1].end + 1500;
    status(true, cues.length + ' lines from ' + name + ' (' + r.format.toUpperCase() + ')');
    $('export').disabled = false;
    return true;
  }
  function status(ok, text) { $('dot').className = 'dot' + (ok ? ' ok' : ''); $('statusText').textContent = text; }

  function handleFiles(files) {
    var vid = null, sub = null;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (/^video\//.test(f.type) || /\.(mp4|webm|mkv|mov|m4v)$/i.test(f.name)) vid = f;
      else sub = f;
    }
    if (vid) {
      video.src = URL.createObjectURL(vid);
      useVideo = true;
      if (!listener && window.SpoilaintListen) listener = SpoilaintListen.attach(video, { getCues: function () { return cues; } });
      video.classList.remove('hidden'); fake.classList.add('hidden');
    }
    if (sub) {
      sub.arrayBuffer().then(function (buf) {
        if (loadSubtitle(decode(buf), sub.name)) showPlayer();
      });
    } else if (vid) {
      showPlayer();
      status(false, 'Video loaded. Now drop its subtitle file.');
    }
  }
  function showPlayer() {
    drop.classList.add('hidden');
    if (!useVideo) fake.classList.remove('hidden');
  }

  // Drag and drop on the whole page.
  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hidden'); drop.classList.add('over'); });
  });
  document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) { drop.classList.remove('over'); if (cues.length) drop.classList.add('hidden'); } });
  document.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); });
  $('pick').addEventListener('change', function (e) { handleFiles(e.target.files); });
  $('sample').addEventListener('click', function () {
    useVideo = false; video.classList.add('hidden');
    loadSubtitle(SAMPLE, 'the sample'); showPlayer(); clock.t = 0; togglePlay(true);
  });

  // Playback controls.
  function playing() { return useVideo ? !video.paused : clock.playing; }
  function togglePlay(force) {
    var want = typeof force === 'boolean' ? force : !playing();
    if (useVideo) { if (want) video.play(); else video.pause(); }
    else { if (want && clock.t >= clock.duration) clock.t = 0; clock.playing = want; clock.last = performance.now(); }
    syncPlayIcon();
  }
  function syncPlayIcon() {
    var p = playing();
    $('icoPlay').classList.toggle('hidden', p); $('icoPause').classList.toggle('hidden', !p);
    $('play').setAttribute('aria-label', p ? 'Pause' : 'Play');
  }
  video.addEventListener('play', syncPlayIcon); video.addEventListener('pause', syncPlayIcon);
  video.addEventListener('seeking', function () { overlay.reset(); });
  $('play').addEventListener('click', function () { togglePlay(); });
  function fmt(ms) { var s = Math.floor(ms / 1000); var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60; return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (ss < 10 ? '0' : '') + ss; }
  function duration() { return useVideo ? (video.duration || 0) * 1000 : clock.duration; }
  var seeking = false;
  $('seek').addEventListener('input', function (e) {
    seeking = true;
    var t = e.target.value / 1000 * duration();
    if (useVideo) video.currentTime = t / 1000; else { clock.t = t; overlay.reset(); }
  });
  $('seek').addEventListener('change', function () { seeking = false; });
  (function tick() {
    var t = now(), d = duration();
    $('time').textContent = fmt(t) + ' / ' + fmt(d);
    if (!seeking && d) $('seek').value = Math.round(t / d * 1000);
    requestAnimationFrame(tick);
  })();

  // Settings.
  function setLag(v) {
    settings.lag = Math.max(-500, Math.min(1500, v));
    $('lag').value = settings.lag;
    $('lagVal').textContent = (settings.lag > 0 ? '+' : '') + (settings.lag / 1000).toFixed(1) + 's';
    overlay.update({ lag: settings.lag });
  }
  $('lag').addEventListener('input', function (e) { setLag(+e.target.value); });
  function segment(id, key) {
    var el = $(id);
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      el.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      var u = {}; u[key] = b.dataset.v; Object.assign(settings, u); overlay.update(u);
    });
  }
  segment('mode', 'mode'); segment('size', 'size'); segment('bg', 'bg');
  var themeBox = $('theme');
  Object.keys(SpoilaintOverlay.THEMES).forEach(function (name) {
    var b = document.createElement('button');
    b.type = 'button'; b.dataset.v = name; b.style.background = SpoilaintOverlay.THEMES[name];
    b.setAttribute('aria-label', name.charAt(0).toUpperCase() + name.slice(1) + ' theme');
    b.setAttribute('aria-pressed', name === settings.theme ? 'true' : 'false');
    themeBox.appendChild(b);
  });
  themeBox.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    themeBox.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    settings.theme = b.dataset.v; overlay.update({ theme: settings.theme });
    document.documentElement.style.setProperty('--accent', SpoilaintOverlay.THEMES[settings.theme]);
  });

  document.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === '[' || e.key === ']')) {
      e.preventDefault(); setLag(settings.lag + (e.key === ']' ? 100 : -100));
      overlay.toast('Delay ' + $('lagVal').textContent);
    } else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); togglePlay(); }
  });

  $('export').addEventListener('click', function () {
    var ass = Spoilaint.toASS(cues, { mode: settings.mode, lag: settings.lag, box: settings.bg === 'box', accent: SpoilaintOverlay.THEMES[settings.theme], highlight: settings.highlight });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + ass], { type: 'text/plain' }));
    a.download = subName.replace(/\.[^.]+$/, '') + '.spoilaint.ass';
    a.click();
  });
})();
