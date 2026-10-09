/*
 * Spoilaint: page-side listener (runs in the page's own JavaScript world, before the site's scripts).
 * Watches the network for subtitle files the video player downloads and hands their text to
 * content.js. Nothing is sent anywhere else, and nothing about the request is changed.
 */
(function () {
  'use strict';
  if (window.__spoilaintInjected) return;
  window.__spoilaintInjected = true;

  var MAX_BYTES = 6 * 1024 * 1024;
  var URL_HINT = /\.(vtt|webvtt|srt|ttml|ttml2|dfxp|xml)(\?|#|$)|timedtext|subtitle|caption|\/subs?\/|texttrack|[?&]fmt=(json3|srv3|vtt)/i;
  var TYPE_HINT = /(text\/vtt|ttml|subrip|x-subrip|text\/xml|application\/xml)/i;
  var knownUrls = Object.create(null); // subtitle URL -> the title it belongs to (Netflix manifests), or true

  function stripQuery(u) { return String(u).split('?')[0]; }
  function isCandidate(url, type) {
    if (!url) return false;
    if (knownUrls[stripQuery(url)]) return true;
    if (URL_HINT.test(url)) return true;
    if (type && TYPE_HINT.test(type)) return true;
    return false;
  }

  // Cheap check of the first characters; the real parsing happens in content.js.
  function looksLikeSubtitles(text) {
    if (!text || text.length < 10) return false;
    var head = text.slice(0, 400).replace(/^﻿/, '').trimStart();
    if (/^WEBVTT/.test(head)) return true;
    if (/<(\w+:)?tt[\s>]/i.test(head) || /<timedtext[\s>]/i.test(head)) return true;
    if (/^<\?xml/.test(head) && /<(\w+:)?tt[\s>]|<timedtext[\s>]/i.test(text.slice(0, 3000))) return true;
    if (head[0] === '{' && /"events"\s*:\s*\[/.test(text.slice(0, 3000)) && /"tStartMs"/.test(text.slice(0, 20000))) return true;
    if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return true;
    return false;
  }

  function send(url, text) {
    if (!looksLikeSubtitles(text)) return;
    // Which title (episode) the file belongs to, so the next episode's subtitles, which Netflix loads
    // before this one ends, aren't shown over this one.
    var movie = knownUrls[stripQuery(url)];
    if (movie === true || movie == null) movie = '';
    var yt = /[?&]v=([\w-]{6,})/.exec(String(url));
    if (!movie && yt && /youtube|googlevideo/.test(String(url))) movie = 'yt:' + yt[1];
    window.postMessage({ __spoilaint: 'subs', url: String(url), text: text, movie: String(movie) }, '*');
  }

  function bufferToText(buf) {
    try { return new TextDecoder('utf-8').decode(buf); } catch (e) { return ''; }
  }

  // ---- fetch ----
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var p = origFetch.apply(this, arguments);
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        p.then(function (res) {
          try {
            var type = res.headers.get('content-type') || '';
            var len = +res.headers.get('content-length') || 0;
            if (!res.ok || len > MAX_BYTES || !isCandidate(res.url || url, type)) return;
            res.clone().text().then(function (text) { send(res.url || url, text); }, function () {});
          } catch (e) {}
        }, function () {});
      } catch (e) {}
      return p;
    };
  }

  // ---- XMLHttpRequest ----
  var XHR = window.XMLHttpRequest;
  if (XHR) {
    var origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      try { this.__spoilaintUrl = String(url); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    var origSend = XHR.prototype.send;
    XHR.prototype.send = function () {
      var xhr = this;
      try {
        xhr.addEventListener('load', function () {
          try {
            var url = xhr.responseURL || xhr.__spoilaintUrl;
            var type = xhr.getResponseHeader('content-type') || '';
            if (xhr.status < 200 || xhr.status >= 300 || !isCandidate(url, type)) return;
            var rt = xhr.responseType;
            if (rt === '' || rt === 'text') { if (xhr.responseText.length <= MAX_BYTES) send(url, xhr.responseText); }
            else if (rt === 'arraybuffer' && xhr.response && xhr.response.byteLength <= MAX_BYTES) send(url, bufferToText(xhr.response));
            else if (rt === 'json' && xhr.response) send(url, JSON.stringify(xhr.response));
            else if (rt === 'blob' && xhr.response && xhr.response.size <= MAX_BYTES) xhr.response.text().then(function (t) { send(url, t); });
            else if (rt === 'document' && xhr.response) send(url, new XMLSerializer().serializeToString(xhr.response));
          } catch (e) {}
        });
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  }

  // ---- Netflix: learn subtitle file URLs from the player's manifest ----
  // The manifest is parsed with JSON.parse; we only read it.
  if (/(^|\.)netflix\.com$/.test(location.hostname)) {
    var origParse = JSON.parse;
    JSON.parse = function () {
      var out = origParse.apply(this, arguments);
      try {
        var res = out && (out.result || out);
        var tracks = res && (res.timedtexttracks || res.textTracks);
        var movie = res && res.movieId != null ? String(res.movieId) : true;
        if (Array.isArray(tracks)) {
          tracks.forEach(function (tr) {
            var dls = tr && tr.ttDownloadables;
            if (!dls) return;
            Object.keys(dls).forEach(function (fmt) {
              var d = dls[fmt];
              var lists = [d.urls, d.downloadUrls && Object.values(d.downloadUrls)];
              lists.forEach(function (l) {
                if (!l) return;
                (Array.isArray(l) ? l : [l]).forEach(function (u) {
                  var url = typeof u === 'string' ? u : u && u.url;
                  if (url) knownUrls[stripQuery(url)] = movie;
                });
              });
            });
          });
        }
      } catch (e) {}
      return out;
    };
  }
})();
