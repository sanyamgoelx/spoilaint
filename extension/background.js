/*
 * Spoilaint background: coordinates "tab audio" listening for sites that hide their sound from
 * web pages (Netflix, Prime Video, Hotstar). The popup asks Chrome for the tab's audio (this needs
 * the viewer's click), a hidden offscreen page records it, keeps it playing to the speakers, and
 * sends loudness readings here; we pass them to that tab's content script.
 */
'use strict';

var capture = null; // { tabId, startedAt, origin }
var lastProblem = {}; // tabId -> message shown in the popup

var offscreenReady = null;
async function ensureOffscreen() {
  var contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'WORKERS'],
      justification: 'Run the speech model on the dialogue of the video being watched, so subtitle words appear when they are spoken.'
    }).catch(function () {}).then(function () { offscreenReady = null; });
  }
  await offscreenReady;
}

function originOf(url) { try { return new URL(url).origin; } catch (e) { return ''; } }

async function startCapture(tabId, streamId) {
  try {
    if (capture) await stopCapture();
    await ensureOffscreen();
    delete lastProblem[tabId];
    var tab = await chrome.tabs.get(tabId).catch(function () { return null; });
    capture = { tabId: tabId, startedAt: Date.now(), origin: tab ? originOf(tab.url) : '' };
    var r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId: streamId, tabId: tabId });
    if (!r || !r.ok) throw new Error((r && r.error) || 'could not start');
    chrome.tabs.sendMessage(tabId, { type: 'spoilaint-tab-audio', on: true }).catch(function () {});
  } catch (e) {
    capture = null;
    throw e;
  }
}

// Alt+S (chrome://extensions/shortcuts): sync to speech on this tab, or stop. A shortcut counts as the
// viewer's click, so Chrome allows tab audio without opening the popup.
chrome.commands.onCommand.addListener(function (command, tab) {
  if (command !== 'sync-speech' || !tab) return;
  var toast = function (text) { chrome.tabs.sendMessage(tab.id, { type: 'spoilaint-toast', text: text }).catch(function () {}); };
  if (capture && capture.tabId === tab.id) { stopCapture(); toast('Stopped listening'); return; }
  chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, function (streamId) {
    if (chrome.runtime.lastError || !streamId) { toast('Chrome didn\'t allow listening to this tab'); return; }
    startCapture(tab.id, streamId).then(function () { toast('Syncing to speech'); }, function (e) { toast('Couldn\'t start: ' + e.message); });
  });
});

async function stopCapture(problem) {
  if (capture && problem) lastProblem[capture.tabId] = problem;
  if (capture) chrome.tabs.sendMessage(capture.tabId, { type: 'spoilaint-tab-audio', on: false }).catch(function () {});
  capture = null;
  try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }); } catch (e) {}
}

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg || msg.target === 'offscreen') return;

  if (msg.type === 'tab-audio-start') {
    startCapture(msg.tabId, msg.streamId).then(function () { reply({ ok: true }); }, function (e) { reply({ ok: false, error: e.message }); });
    return true;
  }

  // A page in the captured tab (re)loaded, e.g. the next episode: it should keep using tab audio.
  if (msg.type === 'tab-audio-hello') {
    reply({ on: !!(capture && sender.tab && sender.tab.id === capture.tabId) });
    return;
  }
  if (msg.type === 'capture-ended' && capture && msg.tabId === capture.tabId) { stopCapture(); return; }
  if (msg.type === 'align-line-score' && msg.tabId != null) {
    chrome.tabs.sendMessage(msg.tabId, { type: 'spoilaint-align-score', key: msg.key, gap: msg.gap, frames: msg.frames }).catch(function () {});
    return;
  }

  if (msg.type === 'tab-audio-stop') { stopCapture().then(function () { reply({ ok: true }); }); return true; }

  if (msg.type === 'tab-audio-status') {
    reply({ tabId: capture && capture.tabId, problem: lastProblem[msg.tabId] || '' });
    return;
  }

  // From the offscreen page: loudness readings for the captured tab.
  if (msg.type === 'audio-frames' && capture && msg.tabId === capture.tabId) {
    chrome.tabs.sendMessage(capture.tabId, { type: 'spoilaint-audio-frames', frames: msg.frames, vad: msg.vad, gain: msg.gain, aligner: msg.aligner, alignStats: msg.alignStats }).catch(function () {});
    return;
  }

  // Speech model: the tab's lines go to the offscreen page; heard words come back to the tab.
  if (msg.type === 'align-lines' && sender.tab) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'align-lines', tabId: sender.tab.id, lines: msg.lines, reset: msg.reset }).catch(function () {});
    return;
  }
  if (msg.type === 'align-reveal' && msg.tabId != null) {
    chrome.tabs.sendMessage(msg.tabId, { type: 'spoilaint-align-reveal', key: msg.key, word: msg.word, wall: msg.wall }).catch(function () {});
    return;
  }
  if (msg.type === 'align-state' && msg.tabId != null) {
    chrome.tabs.sendMessage(msg.tabId, { type: 'spoilaint-align-state', state: msg.state }).catch(function () {});
    return;
  }
  // The page's own sound (sites that allow reading it): straight to the speech model, no Sync needed.
  if (msg.type === 'page-audio' && sender.tab) {
    if (capture && capture.tabId === sender.tab.id) return;
    var tid = sender.tab.id;
    ensureOffscreen().then(function () {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'page-audio', tabId: tid, pcm: msg.pcm, wall: msg.wall }).catch(function () {});
    });
    return;
  }

  // From the content script: the captured sound is pure silence while the video plays.
  if (msg.type === 'tab-audio-silent' && capture && sender.tab && sender.tab.id === capture.tabId) {
    stopCapture('This site sent silence, so Spoilaint stopped listening. In Chrome settings > System, turning off "Use graphics acceleration when available" may let the sound through.');
    return;
  }
});

// Fullscreen while listening: Chrome keeps a recorded tab's fullscreen inside the tab, so the window
// itself goes fullscreen to match (and goes back to how it was afterwards).
var madeFullscreen = null; // { windowId, prev }
async function setWindowFullscreen(tab, on) {
  try {
    if (on) {
      var w = await chrome.windows.get(tab.windowId);
      if (w.state === 'fullscreen') return;
      madeFullscreen = { windowId: tab.windowId, prev: w.state === 'maximized' ? 'maximized' : 'normal' };
      await chrome.windows.update(tab.windowId, { state: 'fullscreen' });
    } else if (madeFullscreen && madeFullscreen.windowId === tab.windowId) {
      var prev = madeFullscreen.prev; madeFullscreen = null;
      await chrome.windows.update(tab.windowId, { state: prev });
    }
  } catch (e) {}
}
chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || msg.type !== 'tab-fullscreen' || !sender.tab) return;
  if (msg.on ? (capture && sender.tab.id === capture.tabId) : true) setWindowFullscreen(sender.tab, !!msg.on);
});

chrome.tabs.onRemoved.addListener(function (tabId) { if (capture && capture.tabId === tabId) stopCapture(); });
chrome.tabs.onUpdated.addListener(function (tabId, info) {
  // Going to another site ends listening; moving within the same site (next episode) keeps it.
  if (capture && capture.tabId === tabId && info.url && capture.origin && originOf(info.url) !== capture.origin) stopCapture();
});

// First install: open the welcome tab (pin tip, preview, how to use it on each kind of site).
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});
