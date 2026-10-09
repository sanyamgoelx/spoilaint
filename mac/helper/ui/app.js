// Spoilaint's window on the Mac: setup, status, VLC settings and the add-to-browser guide.
// Talks to the helper's API on the same address; polls /api/status once a second.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var S = null;               // last status
  var view = null;            // 'setup' | 'main' | 'guide'
  var setupStage = 'welcome'; // welcome | installing | done
  var guide = { browser: null, opened: false, success: false, requireOurs: false, wasAdded: false };
  var editing = 0;
  var wasInstalled = null;   // an update (set up before) or a first install, as it was when the window opened            // settings changed recently: don't overwrite the controls from the server

  function api(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spoilaint': '1' }, body: body ? JSON.stringify(body) : '{}' })
      .then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: 'Spoilaint isn\'t running' }; });
  }
  function show(v) {
    view = v;
    ['setup', 'main', 'guide'].forEach(function (k) { $(k).hidden = k !== v; });
    if (v === 'setup') demoStart(); else demoStop();
    render();
  }

  // ------------------------------------------------------------ demo line (setup screen)
  var LINES = ['I know who took the money.', 'It was never your brother... it was me.', 'Then why did you come back?', 'Because the boat leaves tonight, and you\'re on it.'];
  var demoTimer = null, demoLine = 0;
  function demoStart() { if (!demoTimer) demoPlay(); }
  function demoStop() { clearTimeout(demoTimer); demoTimer = null; }
  function demoPlay() {
    var el = $('demo'), words = LINES[demoLine++ % LINES.length].split(' ');
    el.textContent = '';
    var spans = words.map(function (w) { var s = document.createElement('span'); s.className = 'w'; s.textContent = w; el.appendChild(s); return s; });
    var i = 0;
    (function step() {
      spans.forEach(function (s) { s.classList.remove('f'); });
      spans[i].classList.add('v', 'f');
      var w = words[i++];
      var d = 170 + Math.min(10, w.length) * 24 + (/[.,?!]$/.test(w) ? 360 : 0);
      demoTimer = setTimeout(i < spans.length ? step : function () { spans[spans.length - 1].classList.remove('f'); demoTimer = setTimeout(demoPlay, 1500); }, d);
    })();
  }

  // ------------------------------------------------------------ rendering
  function render() {
    if (!S) return;
    if (view === 'setup') renderSetup();
    if (view === 'main') renderMain();
    if (view === 'guide') renderGuide();
  }

  function renderSetup() {
    if (wasInstalled === null) wasInstalled = !!S.installed;
    var update = wasInstalled;
    $('setupVer').textContent = 'v' + (S.bundle || S.version);
    var inst = S.install;
    if (inst.running) setupStage = 'installing';
    else if (inst.done && setupStage === 'installing') setupStage = 'done';
    $('setupWelcome').hidden = setupStage !== 'welcome';
    $('setupProgress').hidden = setupStage !== 'installing';
    $('setupDone').hidden = setupStage !== 'done';
    $('setupError').hidden = !inst.error;
    $('setupError').textContent = inst.error ? 'Setup didn\'t finish: ' + inst.error : '';
    if (setupStage === 'welcome') {
      $('setupTitle').textContent = update ? 'Update Spoilaint to ' + S.bundle : 'Subtitles that keep up, never run ahead.';
      $('setupBody').textContent = update ? 'Brings the latest timing and fixes. Your settings and synced films stay as they are.'
        : 'Sets up VLC to reveal subtitles word by word as they\'re spoken, and adds a small extension for Netflix, Prime, Hotstar and YouTube. Everything runs on this Mac.';
      $('installBtn').textContent = update ? 'Update' : 'Install';
      $('installBtn').disabled = false;
    } else if (setupStage === 'installing') {
      $('installStep').textContent = (inst.step || 'Working') + ' · ' + Math.round(inst.percent || 0) + '%';
      $('installBar').style.width = Math.max(2, inst.percent || 0) + '%';
    } else {
      var flags = inst.flags || [], lines = [];
      var added = S.browsers.some(function (b) { return b.foundAt; });
      if (flags.indexOf('novlc') >= 0) lines.push('VLC isn\'t installed yet. Install it and Spoilaint turns on by itself.');
      else if (flags.indexOf('vlcrunning') >= 0) lines.push('VLC is open: quit and reopen it, then play any film with subtitles.');
      else if (flags.indexOf('vlcerror') >= 0) lines.push('Couldn\'t turn on VLC\'s automatic mode. Try "Set up VLC" in Spoilaint\'s window.');
      else lines.push('VLC is ready: open any film with subtitles and the words appear as they\'re spoken.');
      lines.push(added ? 'The browser extension picks up this version the next time your browser starts.'
        : 'Last step: add the extension to Chrome, Brave or Edge for Netflix, Prime, Hotstar and YouTube. A short guide walks you through it, about a minute.');
      $('doneTitle').textContent = update ? 'Updated to ' + S.bundle : 'You\'re set';
      $('doneBody').textContent = lines[0];
      $('doneBody2').textContent = lines[1];
      $('toBrowserBtn').textContent = added ? 'Done' : 'Add to my browser';
      $('laterBtn').hidden = added;
      $('toBrowserBtn').dataset.added = added ? '1' : '';
    }
  }

  function ago(t) {
    var d = (Date.now() - new Date(t).getTime()) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + ' min ago';
    var dt = new Date(t), now = new Date();
    if (dt.toDateString() === now.toDateString()) return 'today ' + dt.toTimeString().slice(0, 5);
    return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function addedIn() {
    var n = S.browsers.filter(function (b) { return b.foundAt; }).map(function (b) { return b.name; });
    if (!n.length) return null;
    return n.length === 1 ? n[0] : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
  }

  function mark(el, state, label) {
    el.className = 'mark' + (state ? ' ' + state : '');
    el.textContent = label || '';
  }

  function renderMain() {
    var v = S.vlc, j = S.job;
    $('statusLine').textContent = j ? 'Syncing ' + j.Title + (j.Progress >= 0 ? ' · ' + Math.round(j.Progress * 100) + '%' : '')
      : !v.configured ? 'VLC needs setting up' : 'Running in the background · ready';
    if (!v.installed) { mark($('vlcMark'), 'problem', '!'); $('vlcText').textContent = 'VLC isn\'t installed yet. Install it and Spoilaint turns on by itself.'; $('vlcBtn').textContent = 'Get VLC'; $('vlcBtn').hidden = false; }
    else if (!v.configured) { mark($('vlcMark'), 'problem', '!'); $('vlcText').textContent = 'VLC\'s automatic mode is off, so subtitles won\'t reveal word by word.'; $('vlcBtn').textContent = 'Set up VLC'; $('vlcBtn').hidden = false; }
    else { mark($('vlcMark'), 'done'); $('vlcText').textContent = 'Ready. Open any film in VLC and the subtitles appear word by word.' + (v.running ? ' (Opened VLC before setup? Quit and reopen it.)' : ''); $('vlcBtn').hidden = true; }
    var seen = addedIn();
    mark($('extMark'), seen ? 'done' : '', '2');
    $('extText').textContent = seen ? 'Added to ' + seen + '. Works on Netflix, Prime, Hotstar, SonyLIV, YouTube and more.'
      : 'For Netflix, Prime, Hotstar, SonyLIV, YouTube and more. Browsers only let you add it yourself; a guide walks you through it in about a minute.';
    $('extBtn').hidden = !!seen; $('extAgain').hidden = !seen;

    $('jobBox').hidden = !j; $('idleText').hidden = !!j;
    if (j) {
      $('jobTitle').textContent = j.Title;
      var left = j.SecondsLeft > 0 ? (j.SecondsLeft < 60 ? ' · about ' + Math.max(1, Math.round(j.SecondsLeft)) + ' s left' : ' · about ' + Math.ceil(j.SecondsLeft / 60) + ' min left') : '';
      $('jobPhase').textContent = j.Phase + (j.Progress >= 0 && j.Progress < 1 ? ' · ' + Math.round(j.Progress * 100) + '%' + left : '');
      $('jobBar').style.width = Math.max(2, (j.Progress > 0 ? j.Progress : 0) * 100) + '%';
    }
    var rec = S.recent || [];
    $('recentBox').hidden = !rec.length;
    var ul = $('recent'); ul.textContent = '';
    rec.slice(0, 4).forEach(function (it) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="dot"></span><b></b><span class="when"></span><span class="detail"></span>';
      if (!it.ok) li.firstChild.classList.add('bad');
      li.children[1].textContent = it.title; li.children[2].textContent = ago(it.when); li.children[3].textContent = it.detail;
      ul.appendChild(li);
    });

    if (Date.now() - editing > 3000) {
      var s = S.settings;
      pressed('mode', s.mode); pressed('size', String(s.size < 58 ? 52 : s.size > 71 ? 78 : 64)); pressed('theme', s.theme);
      $('lag').value = s.lag; lagText(s.lag);
      $('highlight').checked = s.highlight; $('box').checked = s.box; $('notify').checked = s.notify; $('atLogin').checked = s.atLogin;
    }
    $('verText').textContent = 'Spoilaint ' + S.version + (S.align ? '' : ' · speech model not set up');
  }

  function pressed(id, v) { $(id).querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false'); }); }
  function lagText(v) { v = +v; $('lagVal').textContent = v === 0 ? 'On time' : (v > 0 ? '+' : '−') + (Math.abs(v) / 1000).toFixed(1) + ' s'; }

  function current() { return S.browsers.filter(function (b) { return b.key === guide.browser; })[0]; }
  function installed() { return S.browsers.filter(function (b) { return b.installed; }); }

  function renderGuide() {
    var list = installed();
    var pick = $('pick');
    if (pick.children.length !== list.length) {
      pick.textContent = '';
      list.forEach(function (b) { var x = document.createElement('button'); x.dataset.v = b.key; x.textContent = b.name; pick.appendChild(x); });
    }
    pick.hidden = list.length < 2;
    $('noBrowser').hidden = list.length > 0;
    if (!list.length) { $('steps').hidden = $('guideDone').hidden = $('manualBtn').hidden = true; return; }
    if (!guide.browser || !current() || !current().installed) pickBrowser(list[0].key, true);
    pressed('pick', guide.browser);
    var b = current();
    var found = b.foundAt && (!guide.requireOurs || b.ours);
    if (found && !guide.success && !guide.wasAdded) guide.success = true; // added while the steps were showing
    var showDone = guide.success || guide.wasAdded;
    $('steps').hidden = showDone; $('guideDone').hidden = !showDone; $('manualBtn').hidden = showDone;
    if (!showDone) {
      $('g1t').textContent = 'Open ' + b.name + '\'s extensions page';
      if (!guide.opened) $('g1d').textContent = 'Opens it in ' + b.name + ' and copies the Spoilaint folder for step 3. ' + b.name + ' may ask to let Spoilaint control it: click OK.';
      $('openBtn').textContent = guide.opened ? 'Open it again' : 'Open ' + b.name + ' extensions';
      $('openBtn').className = 'btn sm' + (guide.opened ? '' : ' primary');
      mark($('g1'), guide.opened ? 'done' : '', '1');
      ['g2', 'g3', 'g4'].forEach(function (id, k) { mark($(id), guide.opened ? '' : 'muted', String(k + 2)); });
      $('g2d').textContent = guide.requireOurs ? 'Remove the old Spoilaint card first, then make sure the Developer mode switch (top right) is on.' : 'The switch at the top right of the extensions page.';
      $('g4d').textContent = 'This ticks itself off a few seconds after ' + b.name + ' adds it.';
      $('waitBar').hidden = !guide.opened;
      document.querySelector('.tile').classList.toggle('hot', guide.opened);
      $('extPath').textContent = S.extDir;
    } else if (guide.wasAdded && !guide.success) {
      $('gdTitle').textContent = 'Spoilaint is already in ' + b.name;
      $('gdText').textContent = b.ours ? 'Just updated Spoilaint? ' + b.name + ' picks up the new version the next time it starts. To use it now, open the extensions page and click the reload arrow on Spoilaint\'s card.'
        : 'It\'s loaded from ' + b.foundAt + ', so updating Spoilaint won\'t update it. To use the installed copy: click Remove on Spoilaint\'s card in ' + b.name + ', then switch below.';
      $('gdOpen').hidden = false; $('gdOpen').textContent = 'Open ' + b.name + ' extensions';
      $('gdSwitch').hidden = b.ours;
    } else {
      $('gdTitle').textContent = 'Added to ' + b.name;
      $('gdText').textContent = 'One more thing: pin it. Click the puzzle piece in ' + b.name + '\'s toolbar, then the pin next to Spoilaint. Then play anything with subtitles on: on Netflix, Prime or Hotstar, click Spoilaint and press Sync to speech.';
      $('gdOpen').hidden = true; $('gdSwitch').hidden = true;
    }
  }

  function pickBrowser(key, quiet) {
    guide.browser = key; guide.opened = false; guide.success = false; guide.requireOurs = false;
    var b = current();
    guide.wasAdded = !!(b && b.foundAt);
    if (!quiet) render();
  }

  // ------------------------------------------------------------ actions
  $('installBtn').onclick = function () { this.disabled = true; setupStage = 'installing'; api('/api/install').then(poll); render(); };
  $('laterBtn').onclick = function () { show('main'); };
  $('toBrowserBtn').onclick = function () { if (this.dataset.added) show('main'); else openGuide(); };
  $('vlcBtn').onclick = function () { api(S.vlc.installed ? '/api/vlc/setup' : '/api/get-vlc').then(poll); };
  $('extBtn').onclick = $('extAgain').onclick = function () { openGuide(this.id === 'extAgain'); };
  function openGuide(other) {
    var list = installed();
    var next = other ? list.filter(function (b) { return !b.foundAt; })[0] : null;
    guide.browser = null;
    show('guide');
    if (next) pickBrowser(next.key);
  }
  $('guideBack').onclick = $('gdDone').onclick = function () { show('main'); };
  $('pick').onclick = function (e) { var b = e.target.closest('button'); if (b) pickBrowser(b.dataset.v); };
  $('openBtn').onclick = $('gdOpen').onclick = function () {
    var b = current(); if (!b) return;
    guide.opened = true; render();
    $('g1d').textContent = 'Opening ' + b.name + '…';
    api('/api/browser/open?b=' + b.key).then(function (r) {
      $('g1d').textContent = r.ok ? 'Opened in ' + b.name + '. The Spoilaint folder is on your clipboard for step 3.'
        : 'Couldn\'t open it (' + (r.error || 'unknown reason') + '). Click into ' + b.name + '\'s address bar, type ' + b.url.replace(/\/$/, '') + ' and press Return.';
    });
  };
  $('gdSwitch').onclick = function () { guide.requireOurs = true; guide.wasAdded = false; guide.success = false; guide.opened = false; render(); };
  $('manualBtn').onclick = function () { guide.success = true; guide.wasAdded = false; render(); };
  $('copyBtn').onclick = function () { var b = this; api('/api/copy').then(function (r) { b.textContent = r.ok ? 'Copied' : 'Couldn\'t copy'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); }); };
  $('revealBtn').onclick = function () { api('/api/reveal'); };
  $('logBtn').onclick = function () { api('/api/open-log'); };
  $('supportBtn').onclick = function () { api('/api/support'); };
  $('quitBtn').onclick = function () { api('/api/quit').then(function () { document.body.innerHTML = '<main><p style="padding:40px 0;text-align:center">Spoilaint has stopped. VLC starts it again when you open a film.</p></main>'; }); };

  $('uninstallBtn').onclick = function () {
    if (!confirm('Remove Spoilaint from this Mac? VLC goes back to normal subtitles. Remove the browser extension from your browser\'s extensions page too, then drag Spoilaint from Applications to the Bin.')) return;
    api('/api/uninstall').then(function () { document.body.innerHTML = '<main><p style="padding:40px 0;text-align:center">Spoilaint is removed. Drag Spoilaint from Applications to the Bin to finish.</p></main>'; });
  };

  function saveSettings() {
    editing = Date.now();
    var s = S.settings;
    var get = function (id) { var b = $(id).querySelector('[aria-pressed=true]'); return b && b.dataset.v; };
    s.mode = get('mode') || s.mode; s.size = +(get('size') || s.size); s.theme = get('theme') || s.theme;
    s.lag = +$('lag').value; s.highlight = $('highlight').checked; s.box = $('box').checked; s.notify = $('notify').checked; s.atLogin = $('atLogin').checked;
    api('/api/settings', s);
  }
  ['mode', 'size', 'theme'].forEach(function (id) {
    $(id).onclick = function (e) { var b = e.target.closest('button'); if (!b) return; pressed(id, b.dataset.v); saveSettings(); };
  });
  $('lag').oninput = function () { lagText(this.value); editing = Date.now(); };
  $('lag').onchange = saveSettings;
  ['highlight', 'box', 'notify', 'atLogin'].forEach(function (id) { $(id).onchange = saveSettings; });

  // ------------------------------------------------------------ polling
  var first = true;
  function poll() {
    return fetch('/api/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
      S = s;
      if (first) {
        first = false;
        var want = location.hash.replace('#', '');
        if (s.needsSetup || s.install.running) show('setup');
        else if (want === 'guide') openGuide();
        else show('main');
      } else render();
    }).catch(function () {});
  }
  poll();
  setInterval(poll, 1000);
})();
