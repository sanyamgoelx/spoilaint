// Welcome tab (opened once, when the extension is first added): pin tip and a looping preview of the reveal.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  // Pin tip: hide for good once dismissed.
  try { if (localStorage.getItem('spoilaint-pin-hidden') === '1') $('pin').hidden = true; } catch (e) {}
  $('pinClose').addEventListener('click', function () {
    $('pin').hidden = true;
    try { localStorage.setItem('spoilaint-pin-hidden', '1'); } catch (e) {}
  });

  // Preview: lines reveal word by word (weighted a little by word length), newest word in the accent colour.
  var LINES = [
    'I know who took the money.',
    'It was never your brother... it was me.',
    'Then why did you come back?',
    'Because the boat leaves tonight, and you\'re on it.'
  ];
  var mode = 'word';
  try { chrome.storage.sync.get({ mode: 'word', theme: 'amber' }, function (s) { if (s && s.mode === 'chunk') setMode('chunk'); }); } catch (e) {}

  var line = $('demoLine');
  var timer = null, li = 0;
  function play() {
    clearTimeout(timer);
    var words = LINES[li % LINES.length].split(' ');
    line.textContent = '';
    var spans = words.map(function (w) { var s = document.createElement('span'); s.className = 'w'; s.textContent = w; line.appendChild(s); return s; });
    if (mode === 'off') { spans.forEach(function (s) { s.className = 'w v'; }); timer = setTimeout(next, 2600); return; }
    var i = 0;
    (function step() {
      var n = mode === 'chunk' ? Math.min(3, spans.length - i) : 1;
      spans.forEach(function (s) { s.classList.remove('f'); });
      for (var k = 0; k < n; k++) { spans[i + k].classList.add('v'); if (k === n - 1) spans[i + k].classList.add('f'); }
      i += n;
      var w = words[i - 1] || '';
      var pause = /[.,!?]$/.test(w) ? 360 : 0;
      var dur = (mode === 'chunk' ? 3 : 1) * (170 + Math.min(10, w.length) * 22) + pause;
      timer = setTimeout(i < spans.length ? step : function () { spans[spans.length - 1].classList.remove('f'); timer = setTimeout(next, 1400); }, dur);
    })();
  }
  function next() { li++; play(); }
  function setMode(m) {
    mode = m;
    $('demoMode').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.v === m ? 'true' : 'false'); });
    play();
  }
  $('demoMode').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setMode(b.dataset.v); });
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) mode = 'off';
  play();
})();
