/*!
 * Spoilaint overlay: draws the word-by-word subtitles on top of a video (or any element).
 * Shared by the test page and the browser extension. Needs spoilaint-engine.js first.
 *
 *   var ov = SpoilaintOverlay.create({
 *     anchor: videoElement,          // element to sit on top of (tracked every frame)
 *     getTime: () => ms,             // current playback time in ms
 *     settings: { mode, lag, size, bg, theme, highlight }
 *   });
 *   ov.setCues(cues); ov.update({lag: 500}); ov.toast('Delay +0.5s'); ov.destroy();
 */
(function (root) {
  'use strict';
  var S = root.Spoilaint;

  var THEMES = {
    amber: '#FFB23F',
    dark: '#E4E0D9',
    indigo: '#8C9BFF',
    green: '#5FD892'
  };
  var SIZES = { S: 0.042, M: 0.052, L: 0.064 };
  var DEFAULTS = { mode: 'word', lag: 0, size: 'M', bg: 'shadow', theme: 'amber', highlight: true };

  var CSS = [
    ':host{all:initial}',
    '.root{position:fixed;pointer-events:none;z-index:2147483646;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;box-sizing:border-box;overflow:hidden}',
    '.stack{display:flex;flex-direction:column;align-items:center;gap:.18em;max-width:86%}',
    '.line{display:flex;flex-wrap:wrap;justify-content:center;column-gap:.28em;row-gap:.06em;font-family:"Atkinson Hyperlegible","Segoe UI","Nirmala UI","Noto Sans Devanagari",system-ui,-apple-system,sans-serif;font-weight:700;line-height:1.28;color:#fff;text-align:center;letter-spacing:.005em}',
    '.shadow .line{text-shadow:0 .06em .12em rgba(0,0,0,.9),0 0 .06em rgba(0,0,0,.95),0 0 .3em rgba(0,0,0,.45)}',
    '.box .line{background:rgba(10,7,5,.78);padding:.16em .5em;border-radius:.22em}',
    '.w{display:inline-block;opacity:0;transform:translateY(.12em);transition:opacity 120ms ease-out,transform 120ms ease-out,color 320ms ease-out;white-space:pre}',
    '.w.v{opacity:1;transform:none}',
    '.w.f{color:var(--accent)}',
    '.nl{flex-basis:100%;height:0}',
    '.toast{position:absolute;top:4%;right:3%;font:600 14px/1 "Segoe UI",system-ui,sans-serif;color:#1E1406;background:var(--accent);padding:8px 12px;border-radius:999px;opacity:0;transition:opacity 200ms}',
    '.toast.on{opacity:1}'
  ].join('\n');

  function create(opts) {
    var settings = Object.assign({}, DEFAULTS, opts.settings || {});
    var cues = [];
    var host = document.createElement('spoilaint-overlay');
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    var rootEl = document.createElement('div');
    rootEl.className = 'root';
    var stack = document.createElement('div');
    stack.className = 'stack';
    var toastEl = document.createElement('div');
    toastEl.className = 'toast';
    rootEl.appendChild(stack);
    rootEl.appendChild(toastEl);
    shadow.appendChild(style);
    shadow.appendChild(rootEl);

    var blocks = {};      // cue key -> {el, spans}
    var lastSig = '';
    var lastRect = '';
    var raf = 0, dead = false, toastTimer = 0;
    var hidden = false;
    var placement = null; // where the site is drawing its own subtitles: {top, bottom} in page pixels

    function mountPoint() {
      var fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (fs && fs.tagName !== 'VIDEO' && fs.contains(opts.anchor)) return fs;
      return document.documentElement;
    }
    function ensureMounted() {
      var mp = mountPoint();
      if (host.parentNode !== mp) mp.appendChild(host);
    }

    function applySettings() {
      rootEl.style.setProperty('--accent', THEMES[settings.theme] || THEMES.amber);
      rootEl.classList.toggle('box', settings.bg === 'box');
      rootEl.classList.toggle('shadow', settings.bg !== 'box');
      lastSig = ''; lastRect = '';
    }

    function place() {
      var a = opts.anchor;
      if (!a || !a.isConnected) { rootEl.style.display = 'none'; return false; }
      var r = a.getBoundingClientRect();
      if (r.width < 40 || r.height < 30) { rootEl.style.display = 'none'; return false; }
      // Letterboxing: fit the video's real picture inside the element.
      var x = r.left, y = r.top, w = r.width, h = r.height;
      if (a.tagName === 'VIDEO' && a.videoWidth && a.videoHeight) {
        var ar = a.videoWidth / a.videoHeight;
        if (w / h > ar) { var nw = h * ar; x += (w - nw) / 2; w = nw; }
        else { var nh = w / ar; y += (h - nh) / 2; h = nh; }
      }
      // Follow the site when it moves its subtitles (up over credits, or to the top of the picture).
      var padBottom = Math.round(h * 0.075), padTop = 0, atTop = false;
      if (placement) {
        var mid = (placement.top + placement.bottom) / 2;
        if (mid < y + h * 0.45) { atTop = true; padTop = Math.max(0, Math.round(placement.top - y)); }
        else {
          var gap = y + h - placement.bottom;
          if (gap > padBottom + h * 0.03) padBottom = Math.round(Math.min(gap, h * 0.8));
        }
      }
      var key = [x, y, w, h, settings.size, padBottom, padTop, atTop ? 1 : 0].map(Math.round).join(',');
      if (key !== lastRect) {
        lastRect = key;
        rootEl.style.display = 'flex';
        rootEl.style.left = x + 'px';
        rootEl.style.top = y + 'px';
        rootEl.style.width = w + 'px';
        rootEl.style.height = h + 'px';
        rootEl.style.justifyContent = atTop ? 'flex-start' : 'flex-end';
        rootEl.style.paddingTop = padTop + 'px';
        rootEl.style.paddingBottom = (atTop ? 0 : padBottom) + 'px';
        var px = Math.max(16, Math.round(h * (SIZES[settings.size] || SIZES.M)));
        stack.style.fontSize = px + 'px';
      }
      return true;
    }

    function render() {
      if (dead) return;
      raf = requestAnimationFrame(render);
      ensureMounted();
      if (hidden || settings.enabled === false) { stack.style.display = 'none'; return; }
      stack.style.display = '';
      if (!place()) return;
      var t = opts.getTime();
      if (t == null || !isFinite(t)) return;
      var state = S.stateAt(cues, t, settings);
      var sig = state.map(function (c) {
        return c.key + ':' + c.words.map(function (w) { return (w.visible ? 1 : 0) + (w.fresh ? 2 : 0); }).join('');
      }).join('|');
      if (sig === lastSig) return;
      lastSig = sig;
      draw(state);
    }

    function draw(state) {
      var keep = {};
      for (var i = 0; i < state.length; i++) {
        var c = state[i];
        keep[c.key] = true;
        var b = blocks[c.key];
        if (!b) {
          var el = document.createElement('div');
          el.className = 'line';
          var spans = [];
          for (var j = 0; j < c.words.length; j++) {
            var s = document.createElement('span');
            s.className = 'w';
            s.textContent = c.words[j].text;
            el.appendChild(s);
            spans.push(s);
            if (c.words[j].br) { var nl = document.createElement('span'); nl.className = 'nl'; el.appendChild(nl); }
          }
          b = blocks[c.key] = { el: el, spans: spans };
        }
        // Keep blocks in start order.
        if (stack.children[i] !== b.el) stack.insertBefore(b.el, stack.children[i] || null);
        for (var k = 0; k < c.words.length; k++) {
          var cls = 'w' + (c.words[k].visible ? ' v' : '') + (c.words[k].fresh && settings.highlight ? ' f' : '');
          if (b.spans[k].className !== cls) b.spans[k].className = cls;
        }
      }
      for (var key in blocks) {
        if (!keep[key]) { blocks[key].el.remove(); delete blocks[key]; }
      }
    }

    applySettings();
    raf = requestAnimationFrame(render);

    return {
      setCues: function (c) { cues = c || []; blocks = {}; stack.textContent = ''; lastSig = ''; },
      getCues: function () { return cues; },
      update: function (s) { Object.assign(settings, s); applySettings(); },
      settings: function () { return settings; },
      setHidden: function (h) { hidden = !!h; },
      // The site's own (hidden) subtitles' box, so ours sit where the site wants them; null = default.
      setPlacement: function (p) { placement = p && isFinite(p.top) && isFinite(p.bottom) ? { top: p.top, bottom: p.bottom } : null; },
      // Clear what's on screen and redraw from the current time (after scrubbing).
      reset: function () { blocks = {}; stack.textContent = ''; lastSig = ''; },
      toast: function (text) {
        toastEl.textContent = text;
        toastEl.classList.add('on');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 1200);
      },
      destroy: function () { dead = true; cancelAnimationFrame(raf); host.remove(); }
    };
  }

  root.SpoilaintOverlay = { create: create, THEMES: THEMES, DEFAULTS: DEFAULTS };
})(typeof self !== 'undefined' ? self : this);
