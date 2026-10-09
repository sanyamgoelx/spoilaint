(function () {
  'use strict';
  var DEFAULTS = { enabled: true, listen: true, mode: 'word', lag: 0, size: 'M', bg: 'shadow', theme: 'amber', highlight: true, disabledSites: [] };
  var THEMES = { amber: '#FFB23F', dark: '#E4E0D9', indigo: '#8C9BFF', green: '#5FD892' };
  var $ = function (id) { return document.getElementById(id); };
  var settings = Object.assign({}, DEFAULTS);
  var host = '';

  function save(patch) { Object.assign(settings, patch); chrome.storage.sync.set(patch); render(); }

  function lagText(v) { return v === 0 ? 'On time' : (v > 0 ? '+' : '\u2212') + (Math.abs(v) / 1000).toFixed(1) + ' s'; }
  function pressed(groupId, value) {
    $(groupId).querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.v === value ? 'true' : 'false'); });
  }
  function siteOff() { return host && settings.disabledSites.indexOf(host) !== -1; }

  function render() {
    $('enabled').checked = settings.enabled;
    $('onLabel').textContent = settings.enabled ? 'On' : 'Off';
    $('lag').value = settings.lag;
    $('lagVal').textContent = lagText(settings.lag);
    pressed('mode', settings.mode === 'chunk' ? 'chunk' : 'word');
    pressed('size', settings.size);
    pressed('bg', settings.bg);
    pressed('theme', settings.theme);
    $('highlight').checked = settings.highlight;
    $('listen').checked = settings.listen !== false;
    document.documentElement.style.setProperty('--accent', THEMES[settings.theme] || THEMES.amber);
    $('siteToggle').textContent = siteOff() ? 'Turn on for this site' : 'Turn off on this site';
    $('siteToggle').hidden = !host;
    preview();
  }

  // A short line revealing in the chosen style and colour, so the settings show what they do.
  var pvTimer = null, pvMode = null, pvHi = null;
  function preview() {
    var mode = settings.mode === 'chunk' ? 'chunk' : 'word';
    if (mode === pvMode && settings.highlight === pvHi) return;
    pvMode = mode; pvHi = settings.highlight;
    clearTimeout(pvTimer);
    var el = $('preview'), words = 'Wait for it... the twist is coming'.split(' ');
    (function loop() {
      el.textContent = '';
      var spans = words.map(function (w) { var s = document.createElement('span'); s.className = 'w'; s.textContent = w; el.appendChild(s); return s; });
      var i = 0;
      (function step() {
        var n = mode === 'chunk' ? Math.min(3, spans.length - i) : 1;
        spans.forEach(function (s) { s.classList.remove('f'); });
        for (var k = 0; k < n; k++) { spans[i + k].classList.add('v'); if (k === n - 1 && settings.highlight) spans[i + k].classList.add('f'); }
        i += n;
        pvTimer = setTimeout(i < spans.length ? step : function () { spans[spans.length - 1].classList.remove('f'); pvTimer = setTimeout(loop, 1200); }, (mode === 'chunk' ? 3 : 1) * 260);
      })();
    })();
  }

  function status(dot, title, sub) {
    $('dot').className = 'dot' + (dot ? ' ' + dot : '');
    $('statusTitle').textContent = title;
    $('statusSub').textContent = sub || '';
  }

  var lastInfo = null;
  function showSpeech(info, capturing, problem) {
    var box = $('speech');
    box.hidden = !(settings.enabled && !siteOff() && info && info.video && info.kind && !(info.listening && !info.tabAudio));
    if (box.hidden && !problem) return;
    box.hidden = false;
    var btn = $('syncBtn');
    if (capturing) {
      btn.textContent = 'Stop listening'; btn.classList.add('stop');
      $('speechTitle').textContent = info && info.heard ? 'Listening to this tab · words follow the speech' : 'Listening to this tab…';
      if (info && info.speechModel === 'on') $('speechTitle').textContent = 'Listening to this tab · ' + (info.muted ? 'paused while muted' : info.mismatch ? 'subtitles don\'t match the audio (estimated timing)' : 'matching words to speech');
      else if (info && info.voiceDetector === 'on') $('speechTitle').textContent += info.voiceInUse ? ' · following voices' : ' · learning the voices';
      $('speechSub').textContent = 'Chrome shows a sharing icon on the tab while Spoilaint listens.';
    } else {
      btn.textContent = 'Sync to speech'; btn.classList.remove('stop');
      $('speechTitle').textContent = problem ? 'Couldn\'t hear this tab' : 'This site hides its sound from web pages';
      $('speechSub').textContent = problem || 'Let Spoilaint listen to this tab for exact word timing. One click each time you start watching.';
    }
  }

  function showStatus(info) {
    lastInfo = info;
    if (!settings.enabled) return status('', 'Spoilaint is off', 'Switch it on to use it on any video.');
    if (siteOff()) return status('', 'Off on this site', host);
    if (!info) return status('', 'No video here yet', 'Open a movie or show and turn on its subtitles.');
    if (!info.video) return status('', 'No video playing on ' + info.site, 'Start a video and turn on its subtitles.');
    if (!info.kind) return status('warn', 'Waiting for subtitles on ' + info.site, 'Turn on subtitles in the player.');
    if (info.suppressed) return status('', 'Subtitles are off in the player', 'Turn them on and Spoilaint takes over.');
    var heard = info.listening ? (info.speechModel === 'on' && !info.tabAudio ? (info.mismatch ? ' · subtitles don\'t match the audio' : ' · matching words to speech') : ' · synced to speech') : '';
    if (info.kind === 'network') return status('ok', 'Working on ' + info.site, 'Full subtitle track loaded · ' + info.lines + ' lines' + heard);
    if (info.kind === 'track') return status('ok', 'Working on ' + info.site, 'Using the video\'s subtitle track · ' + info.lines + ' lines' + heard);
    return status('warn', 'Working on ' + info.site, 'Reading on-screen subtitles (timing is a little rougher)');
  }

  // Wire up controls.
  $('enabled').addEventListener('change', function (e) { save({ enabled: e.target.checked }); refreshStatus(); });
  $('lag').addEventListener('input', function (e) { save({ lag: +e.target.value }); });
  function group(id, key) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var p = {}; p[key] = b.dataset.v; save(p);
    });
  }
  group('mode', 'mode'); group('size', 'size'); group('bg', 'bg'); group('theme', 'theme');
  Object.keys(THEMES).forEach(function (name) {
    var b = document.createElement('button');
    b.type = 'button'; b.dataset.v = name; b.style.background = THEMES[name];
    b.setAttribute('aria-label', name.charAt(0).toUpperCase() + name.slice(1) + ' theme');
    $('theme').appendChild(b);
  });
  $('highlight').addEventListener('change', function (e) { save({ highlight: e.target.checked }); });
  $('listen').addEventListener('change', function (e) { save({ listen: e.target.checked }); });
  $('siteToggle').addEventListener('click', function () {
    var list = settings.disabledSites.slice();
    var i = list.indexOf(host);
    if (i === -1) list.push(host); else list.splice(i, 1);
    save({ disabledSites: list });
    refreshStatus();
  });

  var tabId = null;
  function refreshStatus() {
    if (tabId == null) return showStatus(null);
    chrome.tabs.sendMessage(tabId, { type: 'spoilaint-status' }, function (info) {
      if (chrome.runtime.lastError) info = null;
      showStatus(info);
      chrome.runtime.sendMessage({ type: 'tab-audio-status', tabId: tabId }, function (st) {
        if (chrome.runtime.lastError) st = null;
        showSpeech(info, st && st.tabId === tabId, st && st.problem);
      });
    });
  }

  $('syncBtn').addEventListener('click', function () {
    var btn = $('syncBtn');
    if (btn.classList.contains('stop')) {
      chrome.runtime.sendMessage({ type: 'tab-audio-stop' }, function () { setTimeout(refreshStatus, 200); });
      return;
    }
    btn.disabled = true;
    // Asking for the tab's sound only works right after the viewer's click, so it happens here.
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, function (streamId) {
      if (chrome.runtime.lastError || !streamId) {
        btn.disabled = false;
        showSpeech(lastInfo, false, 'Chrome didn\'t allow listening to this tab: ' + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'unknown reason'));
        return;
      }
      chrome.runtime.sendMessage({ type: 'tab-audio-start', tabId: tabId, streamId: streamId }, function (r) {
        btn.disabled = false;
        if (!r || !r.ok) showSpeech(lastInfo, false, 'Couldn\'t start listening: ' + ((r && r.error) || 'unknown reason'));
        setTimeout(refreshStatus, 1500);
      });
    });
  });

  $('reportBtn').addEventListener('click', function () {
    chrome.tabs.sendMessage(tabId, { type: 'spoilaint-diagnostic' }, function (data) {
      if (chrome.runtime.lastError || !data) { $('reportBtn').textContent = 'No video with subtitles on this page'; return; }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      a.download = 'spoilaint-report-' + (data.host || 'site') + '-' + data.savedAt.replace(/[:.]/g, '-') + '.json';
      a.click();
      $('reportBtn').textContent = 'Saved to your Downloads folder';
    });
  });

  chrome.storage.sync.get(DEFAULTS, function (s) {
    settings = Object.assign({}, DEFAULTS, s);
    render();
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (tab) {
        tabId = tab.id;
        try {
          var u = new URL(tab.url || '');
          if (/^https?:$/.test(u.protocol)) host = u.hostname.replace(/^www\./, '');
        } catch (e) {}
      }
      render();
      refreshStatus();
    });
  });
})();
