# Spoilaint

**Subtitles that keep up, never run ahead.** Spoilaint shows subtitles word by word, as they're spoken, so you never
read the twist before the actor says it. For VLC (Windows and macOS) and Chrome, Brave and Edge (Netflix, Prime
Video, JioHotstar, SonyLIV, YouTube and most other video sites).

- **Exact timing:** a small speech model, running entirely on your computer, finds the moment each subtitle word is
  spoken. Nothing you watch or hear leaves your computer.
- **Fixes bad subtitle files:** subtitles that run early, late or drift (made for another frame rate) are detected
  and corrected in VLC.
- **Never early:** when it can't hear a line (dubbed audio, wrong subtitles), it falls back to estimated timing with
  a small safety margin.

## Download

Get the latest from [Releases](https://github.com/sanyamgoelx/spoilaint/releases):

| | |
|---|---|
| **Windows 10/11** | `Spoilaint-Setup-<version>.exe`: sets up VLC, the background app and the browser extension. Windows may show "Windows protected your PC" (the installer isn't code-signed yet): *More info* > *Run anyway*. |
| **macOS 11+** (Apple Silicon and Intel) | `Spoilaint-<version>-mac.dmg`: drag Spoilaint to Applications and open it. It isn't signed by an Apple developer account yet, so the first time: System Settings > Privacy & Security > *Open Anyway*. Not yet tested on a real Mac: reports welcome. |
| **Browser extension only** | `spoilaint-extension.zip`: unzip, then `chrome://extensions` > Developer mode > *Load unpacked*. (The installers' guide does this for you.) |

VLC itself: [videolan.org](https://www.videolan.org/vlc/). Open any film with subtitles (a `.srt` next to it, or
subtitles inside an `.mkv`) and they reveal word by word. On Netflix, Prime and Hotstar, click Spoilaint and press
*Sync to speech* (or Alt+S) once per viewing; on YouTube it just works.

## Credits

- Speech model: NVIDIA NeMo Conformer-CTC small (English, CC-BY-4.0, (c) NVIDIA), int8 ONNX from [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Shipped unchanged in the installers.
- Voice detector: [Silero VAD](https://github.com/snakers4/silero-vad) (MIT). Runtime: [ONNX Runtime](https://github.com/microsoft/onnxruntime) (MIT).
- [FFmpeg](https://ffmpeg.org) (Windows: LGPL build from BtbN/FFmpeg-Builds; macOS: eugeneware/ffmpeg-static). Full notices: `store/THIRD_PARTY_NOTICES.txt` and the installers.

Spoilaint's own code is under the [MIT licence](LICENSE).

---

# Development notes

## What's here

| Folder | What it is |
|---|---|
| `engine/` | The timing engine (`spoilaint-engine.js`) and the on-screen renderer (`spoilaint-overlay.js`). Shared by the test page and the extension. |
| `vlc/spoilaint.lua` | VLC automatic mode. A port of the engine's timing; keep them in sync. |
| `extension/` | Chrome/Brave extension (Manifest V3). |
| `test-page/` | Drop a movie and its subtitles (or just a subtitle file) and watch the reveal. Open `test-page/index.html`. |
| `tray/` | Windows tray app (C#, .NET Framework 4.x): runs ffmpeg for VLC with no console windows, shows progress, settings and setup. |
| `installer/` | NSIS installer: sets up VLC, copies the extension, adds an uninstaller. |
| `mac/` | macOS: Go helper (`mac/helper`, the Mac counterpart of `tray/`), app window (`mac/helper/ui`), packaging (`mac/build.sh`). |
| `dist/` | Built output (made by `node build.js`). |

## Build

The speech model, FFmpeg and ONNX Runtime aren't in the repository (size and licences): put them in
`installer/vendor/` (see `installer/vendor/speech-model/README.txt` once downloaded, and the header of `mac/build.sh`).

```
node build.js                      # dist/extension, dist/spoilaint-extension.zip, dist/vlc
sh tray/build.sh                   # dist/app/Spoilaint.exe (tray app; needs mono-devel)
makensis installer/spoilaint.nsi   # dist/Spoilaint Setup 0.8.0.exe (needs installer/vendor: ffmpeg.exe, onnxruntime.dll, speech-model/) (needs installer/vendor/ffmpeg.exe, LGPL build from BtbN/FFmpeg-Builds)
```

## Tests

```
node engine/test/engine.test.js                       # engine (22 tests)
lua5.1 vlc/test/parity.lua <in.srt> <out.ass> word 300 # VLC script output
node vlc/test/parity.js <in.srt> <out.ass> word 300    # must match the line above byte for byte
```

## How the timing works

Subtitle files only say when a whole line shows. Spoilaint spreads the words across that window:
longer words (more syllables) get more time, and commas, full stops and "..." add short pauses.
Speech is capped at about 4 syllables a second, so a short line held on screen for a long time
isn't stretched out. YouTube's auto-captions carry real per-word times, and those are used as they are.
Estimated lines get an automatic +0.3 s safety margin; the Delay setting (default 0) shifts everything on top of that.

## Speech sync (0.2.0)

**VLC:** the first time a movie opens, ffmpeg reads its dialogue in the background (the centre channel of
5.1, or the middle of stereo) into a loudness track, 50 values a second. For each line, the script finds the
stretches where someone is talking (loud enough, and wobbling the way syllables do) and the syllable peaks
inside them, then fits the words onto the syllables with dynamic programming. It switches to the synced
version when it's ready (about a minute for a film) and reuses it next time. On the bench, words more than
0.1 s early fell from ~60% to ~4% (stereo) / ~2% (5.1), average error ~130-190 ms.

**Browser:** `engine/spoilaint-listen.js` listens live where the site allows reading the video's sound
(YouTube, most non-DRM players). A word is revealed once the syllables before it have been heard, so it
rarely runs early (~10-14% vs ~40-70%), but it trails speech by ~0.4-0.6 s. DRM sites (Netflix, Prime,
Hotstar) give silence, so they stay on the estimate.

**Delay setting:** 0 = on time. Lines only estimated get +300 ms automatically.

**Bench:** `bench/make_bench.py` builds test films with known word times (espeak-ng voices, music and
effects); `bench/dump.lua` + `bench/score.py` / `bench/evalenv.py` score a run.

## Display rules (0.2.1)

- **Rows shown together are one subtitle.** Lines with the same start and end (within 40 ms) merge, top row
  first (TTML region origin, WebVTT `line:`, SRT `{\an8}`). Netflix sends each row of a two-row subtitle as its
  own line; without this both rows revealed in parallel.
- **Helper text isn't animated.** `[door creaks]`, `(laughs)` and speaker labels (`JOHN:`) appear with the
  spoken word before them (or with the line), take no speaking time, are never coloured as newest, and are
  skipped by speech matching.
- **Scrubbing:** the browser overlay redraws for the new position; live listening forgets the old position,
  relearns the sound level, and when landing mid-sentence shows the words already said. VLC's .ass track
  follows seeks by itself.

## Tab audio (0.3.0)

Netflix, Prime Video and Hotstar hide their sound from web pages (`captureStream` throws on DRM video), so
page listening can't hear them. The popup's **Sync to speech** button asks Chrome for the tab's audio
(`chrome.tabCapture.getMediaStreamId`, needs the viewer's click, once per viewing). `background.js` opens
`offscreen.html`, which records the tab, plays it back to the speakers (Chrome mutes a captured tab) and sends
loudness readings every 20 ms in 50 ms batches; `content.js` maps them to the video clock and feeds the live
listener. If the readings are pure silence for 6 s while the video plays, capture stops and the popup suggests
turning off Chrome's graphics acceleration (reported to block DRM audio). Untested on real Netflix so far.

**Timing report:** More options > *Save a timing report* downloads the last ~10 minutes of loudness readings
plus the subtitle words with their estimated and shown times, to tune live matching on real dialogue.

## Voice detector (0.4.0)

On real Netflix audio (Friends), loudness couldn't tell dialogue from the laugh track. Tab audio now also runs
**Silero VAD v5** (MIT, ~2 MB) with ONNX Runtime Web 1.20.1 (WebAssembly, single thread) inside `offscreen.html`:
an AudioWorklet (`pcm-worklet.js`) taps the tab's sound behind two 7 kHz low-passes, `engine/spoilaint-vad.js`
resamples to 16 kHz and scores 32 ms windows. Each 20 ms reading sent to the tab is now `[wall ms, dB, speech
probability]`. Everything runs on the viewer's computer; the manifest needs `'wasm-unsafe-eval'`.

Checked in Chromium on real speech mixed with laughter and music: the extension's scores match the reference
run (correlation 0.99999), whole-pipeline AUC 0.92 vs 0.72 for loudness, about 20x faster than real time. The
detector's readings trail the sound by ~0.1 s.

**0.4.1, from a real Friends timing report (8 min, tab audio):** the detector separated dialogue from the laugh
track (AUC 0.90 against the subtitle windows; loudness 0.45, i.e. no better than chance), but scored low because
Netflix's tab audio is ~28 dB quieter than a normal recording: only 18% of lines reached 0.5. Fixes:

- `spoilaint-vad.js` boosts the audio before the model so the loud part of the last ~8 s sits near RMS 0.15
  (gain 1-100x, eased). On real speech turned down 30 dB this brings speech caught at 0.5 from 40% back to 76%.
- The listener lets the detector decide talking (`prob >= 0.5` and above the quiet level) only after it proves
  itself: it must have heard a voice (200 ms+) in 60% of the last 20 lines (`trustAfter`, `trustShare`). Until then
  it uses loudness as before. The popup shows "learning the voices" / "following voices"; the report has `voice`.

**0.4.2, from the second Friends report:** with 0.4.1's gain the detector heard 77% of lines and took over,
but it also fired in 12% of gaps with no subtitle (vs 0% before) and separation fell to 0.64: Silero scores
loud crowd laughter as speech. Tested on real LibriSpeech lines followed by real crowd laughter (layered ESC-50
laughing + clapping): at full level laughter scores >= 0.5 27% of the time, at Netflix's level 0%. The level is
now evened to RMS 0.04 (turned up or down, 0.1-100x): speech 75%, laughter 3%, at any input level; speech +
music test unchanged (AUC 0.90). Reports now include `voiceGain`.

## Netflix placement and fullscreen (0.4.1)

- **Placement:** our subtitles follow where the site draws its own (still laid out under `opacity: 0`): the
  text's box is measured each scan; if the site lifts it (over on-screen credits) ours rise to the same bottom
  edge, and if it's in the top half ours move to the top. Otherwise the default spot. Tested on a mock player.
- **Fullscreen while listening:** Chrome keeps a recorded tab's fullscreen inside the tab, so the player didn't
  fill the screen. When the page goes fullscreen during tab audio, `background.js` makes the window fullscreen
  (`chrome.windows.update`) and puts it back on exit.

## Next episode (0.4.3)

Near the end of an episode Netflix downloads the next episode's subtitle file, and the newest file used to win,
so the next episode's lines showed over the credits. Each caught file is now tagged with its title: Netflix's
manifest `movieId` (read with the subtitle URLs; `timedtexttracks` or `textTracks`), YouTube's `v=`. The file in
use is the latest one for the title in the address bar (`/watch/<id>`, `?v=`). If the ids don't match (Netflix
sometimes uses a show id in the URL), a file for a different title only takes over after a new video starts
(`loadstart` or the address changing). Tested on a mock Netflix page for both cases. Reports include `title`
and `fileTitle`.

## Hiding unknown players' subtitles (0.4.4)

On Hotstar the site's own subtitles stayed on screen: its player uses class names no selector list knows. Now,
when Spoilaint has the subtitle file, a MutationObserver on the player (the video's widest ancestor that is
still about the video's size) checks text that just appeared or changed: if it is part of a line due within
±1.5 s and sits over the video, its widest container holding only subtitle text is hidden. The observer runs
before paint, so the site's line doesn't flash. Static text (a title that matches a line), buttons and links
are never taken. Found elements also feed "subtitles switched off" detection and placement following.
Tested on a mock Hotstar player (one container reused, and a new element per line): site subtitles visible
in 1 of 424 frames (the first line, before learning), a matching title and a button left alone.

## Where subtitles come from in the browser (best first)

1. **The subtitle file the player downloads** (caught as it loads: WebVTT, TTML/DFXP, SRT, YouTube json3/srv3). Netflix's subtitle URLs are learned from its player manifest.
2. **The video's own text track** (`<track>` / `textTracks`).
3. **The site's on-screen subtitles**, read as they appear. Works almost anywhere, but only learns each line when it appears.

The site's own subtitles are hidden (`opacity: 0`) while Spoilaint's are showing. If the site stops showing
subtitles for a few seconds while ours would be up (subtitles switched off), Spoilaint steps aside.

## Settings

- Browser: the toolbar panel. `Alt+[` / `Alt+]` nudge the delay while watching.
- VLC: `%APPDATA%\vlc\spoilaint.ini` (mode, lag, theme, highlight, size, box, font, ffmpeg). Restart VLC after editing.

## Known limits

- Translated subtitles don't follow the spoken word order, so the reveal is an estimate of pace, not of words.
- VLC: extracting built-in .mkv subtitles needs ffmpeg (on PATH, or set `ffmpeg=` in the ini). Picture-based subtitles (PGS/VobSub) can't be used.
- Hotstar: confirmed the network file is caught; hiding by text added in 0.4.4. SonyLIV untested.

## No skipped words, no flashing line ends (0.4.5)

- **Hold:** a line stays on screen until its last word has been up for at least 0.8 s (`TUNING.holdMs`, same in
  the Lua script). If the next line has already started, the old one stays above it for that moment. Normal
  subtitles (mode off) keep their own timing.
- **Nothing after the end:** a word timed past its line's end (speech matching packing late words against the
  end, or a site's on-screen line vanishing before our replay finished) now shows when the line ends instead of
  never. Before this, VLC gave such words a 20 ms event, shorter than a video frame, so they were never drawn.
- **Live listening:** words heard in the same instant appear at least 70 ms apart (`staggerMs`) instead of in a clump.
- **No audio errors on ordinary pages:** live listening used to create its AudioContext on any page with a video
  (a shop's product video, for example), and Chrome logged "The AudioContext was not allowed to start" in
  chrome://extensions. It now waits until the video has subtitles and the viewer has clicked or pressed a key.

## Spoilaint app in the tray (0.5.0)

`tray/` builds `Spoilaint.exe` (~100 KB, .NET Framework 4.x, which ships with Windows 10/11). The installer starts it with
Windows (`HKCU\...\Run`, `--background`), adds Start menu shortcuts (app + browser extension setup) and opens it on
the last page.

- **No console windows:** VLC's script no longer runs ffmpeg itself. It writes a job file to
  `%LOCALAPPDATA%\Spoilaint\jobs` (`<base>.speech.job`, `extract-*.job`: key=value lines ending `end=1`) and the
  app runs ffmpeg hidden (`CreateNoWindow`, below-normal priority), writing the same outputs as before
  (`.speech.txt/.err/.done` in VLC's cache, `<out>.done` with the job id for .mkv subtitles). The app rewrites
  `helper.alive` (unix time) every 2 s; if it's stale VLC starts the app once, and if the app isn't installed it
  falls back to the old hidden-console script. After syncing, VLC writes `<base>.result` (lines matched) for the app.
- **Window:** setup checklist (VLC status with a fix button; browser extension: "Show me how" / "I've added it",
  stays until marked done), activity (film, phase, progress, time left; recent films with lines matched),
  VLC subtitle settings (writes `%APPDATA%\vlc\spoilaint.ini`; VLC now re-reads it for every film), start with
  Windows, notifications. Closing the window keeps it in the tray; Quit is in the tray menu.

## Precise word timing: forced alignment (0.6.0)

**Why:** a real-speech bench (`bench/make_real_bench.py`: TIMIT sentences, real voices with hand-marked word times,
mixed with music, effects and a laugh track, subtitles timed like a human subtitler) showed the loudness method
reveals ~29% of words early on real connected speech, no better than the estimate. The espeak bench (separate words)
had hidden that.

**How:** the subtitles already say what is said, so a small speech model only has to find where. NVIDIA NeMo
Conformer-CTC small (English, int8 ONNX from k2-fsa/sherpa-onnx, 46 MB, `installer/vendor/speech-model`) gives
token probabilities every 40 ms from 80-band log-mel features; a CTC Viterbi forced alignment over the line's tokens
gives each word's first frame; -70 ms corrects the model's firing delay. Lines scoring below -7 (wrong or other-language
text; right text scores around -1) keep the estimate (+300 ms margin).

| real-speech bench | early (>0.1 s) | within 0.1 s | avg error |
|---|---|---|---|
| VLC loudness (0.5.0) | 28-30% | 18-29% | 260-510 ms |
| VLC aligned (0.6.0) | 0.2-0.4% | 90-92% | ~55 ms |
| browser live, loudness | 1.5-11.5% | 5-7% | 840-940 ms late |
| browser live, aligned | 0% | (live) | ~590-920 ms late |

- **VLC:** the script writes `<base>.words.txt` (one line per subtitle: start, end, helper-text flags, words) and an
  `align` job; the tray app (`tray/Align.cs`: ONNX Runtime's C API via P/Invoke, no NuGet; fbank, tokenizer, Viterbi)
  streams the film's dialogue from ffmpeg (16 kHz mono, centre channel of 5.1), aligns only the audio around each line,
  writes `<base>.align.txt` (hash of the words + one line of times per subtitle). ~15 s per 12 min of film on 2 threads.
  The app advertises it with `helper.alive` = "<time> align". Older path (loudness) remains when the app or model is missing.
- **Browser (tab audio):** `engine/spoilaint-align.js` runs the same model with ONNX Runtime Web in the offscreen page
  (replaces the voice detector). The content script sends the lines from 2 s ago to 10 s ahead in wall-clock time every
  second (and on seek/pause/play/rate change); every 320 ms while a line is on screen the model runs on the newest 320 ms
  plus 800 ms before it, the newest 600 ms of output is recomputed next time (it lacked right context), and a prefix
  Viterbi per line says how far into it the speaker is. Heard words come back and are shown at once; the listener only
  holds words back. ~63 ms per step in Chromium (about 20% of one core while a line is up).
- **Bench:** `bench/ctc_align.py` (Python reference), `bench/live_sim.py` (live simulation), `bench/live_js.js`
  (the real JS module on a bench film), `bench/live_now.js` (old live listener), `bench/score2.py` (scores TSVs).
  `tray/test/AlignTest.cs` runs the C# aligner on Linux with Mono + libonnxruntime.so.

## Browser edge cases (0.6.1)

- **Subtitles that don't match the audio** (a Hindi dub with the original's English subtitles, other words): every
  finished line gets a match score from the speech model (how much worse the best path through the line's words is
  than an unconstrained path, per frame: matching ~0.2, wrong text ~0.9). Median of the last 5 lines over 0.6 =
  mismatch: words go back to estimated timing (the model would otherwise hold them ~1.5 s late); under 0.45 = back on.
  Bench (`bench/live_js.js` writes `.scores`; shuffled-subtitle copy of rb1): no false switches on rb1/rb2, mismatch
  caught after 2 lines. Wrong text was never a spoiler risk (0.4% of words >20% of a line ahead vs 7.5% for the estimate;
  `bench/ahead.py`).
- **Muted player:** tab audio is silent, so estimated timing until unmuted.
- **Picture-in-picture:** our overlay can't be drawn in the PiP window, so the site's own subtitles show while in PiP.
- **Next episode / reload:** listening continues while the tab stays on the same site (it stopped on any page load
  before); a reloaded page asks the background (`tab-audio-hello`) and picks it up again.
- **Alt+S** (change at chrome://extensions/shortcuts): sync to speech on this tab, or stop, without the popup
  (a shortcut counts as the viewer's click for tab capture).
- **Alt+B:** saves a timing report marking the current moment as "timing looked wrong" (Downloads).

## Less delay, no clumps, no Sync needed where the page's sound is readable (0.6.2)

From a real Netflix timing report (a trailer, Sync off, so the old loudness listener): words clumped and trailed.
- **Speech model on page audio:** where the page can read the video's sound (trailers, YouTube, non-DRM players),
  the listener sends it at 16 kHz to the offscreen page's speech model (`page-audio` messages); no Sync click.
  Tab capture (Sync) still takes priority for DRM sites. Full-pipeline test in Chromium (bench clip, non-DRM page):
  model on after ~3 s, 97/97 words matched, median 0.2 s after the real start.
- **Steps of 160 ms** instead of 320 (bench: ~90 ms less delay, clumped word pairs 19% -> 11%), ~57-67 ms of work per
  step in Chromium on a slow server CPU.
- **One-word prediction:** the model knows when each word it heard started (backtrace, +-80 ms), so the next word is
  shown at that start + its syllables at this line's pace + 200 ms, unless the model hears it first; never across
  punctuation or a speaker dash. Bench (`bench/predict.py`): median delay 0.44 -> 0.27-0.30 s, early words 0.2-0.4%;
  predicting two or more words ahead gave 2-8% early, so it stops at one.
- Before the model is running, the listener no longer reveals a line's first word on any sound.
- Bench (`bench/live_js.js`, real JS module): rb1 median 531 -> 257 ms, rb2 715 -> 494 ms, early 0.4%.

## Out-of-sync subtitle files, faster playback (0.6.3)

- **VLC: subtitles shifted against the film** (another release, a different intro; common with downloaded .srt files)
  used to fall back to the estimate, and a file running early spoiled every word. Before aligning, the app samples up
  to 30 lines across the film (`Aligner.DetectOffset`), runs the model on +-15 s around each (ffmpeg input seek),
  finds each line by scoring every shift in 0.2 s steps, then measures where its speech really starts against the
  subtitle (subtitlers lead the voice by ~0.15 s). If 60% of lines agree, every line moves by that shift (`offset=` in
  `<base>.align.txt`; the VLC script shifts cues and estimates before applying). After 8 lines that already fit,
  it stops looking (in-sync subtitles cost ~10 s more per film). Bench: shifts of +3.2 s and -2.1 s detected as
  +3.22/-2.08 s, 92% of words within 0.1 s afterwards; no false shift on in-sync subtitles.
- **Drifting subtitles (0.6.4):** made for another frame rate (25 vs 23.976/24 fps), so right at the start and seconds
  out by the end. When no single shift fits, the six usual ratios are tried on 12 lines each; the one most lines agree
  on stretches every line (`scale=` after `offset=` in align.txt). Bench (25 fps subtitles on 23.976 + 1 s): found
  x1.0427 +1.01 s; words 15 s early on average before, 92% within 0.1 s after.
- **Browser at 1.5x:** the model still shows no early words (median 0.38 s late in audio time); the mismatch switch
  raises its bar with speed (0.6 + 0.3 x (rate - 1)) after two false switches at 1.5x with the old fixed 0.6.
- Page-audio path: two low-passes and linear resampling before 16 kHz (like the tab-audio path).
- Hindi: the sherpa-onnx Dolphin base CTC model (100 MB int8, 40k tokens incl. 835 Devanagari) can align Hindi
  subtitles in principle; parked until there is real Hindi speech with known word times to test against.

## Windows readiness, test suite, store kit (0.6.5)

- **Windows review fixes** (independent review of the tray app, installer and VLC glue; nothing has run on Windows yet):
  - ONNX Runtime needs the VC++ 2019+ runtime: msvcp140.dll, msvcp140_1.dll, vcruntime140.dll, vcruntime140_1.dll now
    ship next to onnxruntime.dll (`installer/vendor/vcrt`, from the msvc-runtime package on PyPI). The app only
    advertises "align" if ONNX Runtime really loads and ffmpeg is installed, so VLC falls back instead of failing films.
  - Align jobs: the done-marker carries the job id and VLC deletes an old one before submitting (a stale marker made
    retries fail at once).
  - Installer: closes the app cleanly (`Spoilaint.exe --quit`) then `taskkill /T` (its ffmpeg too), `/REBOOTOK`
    deletes, 64-bit check, uninstall removes VLC's Spoilaint cache and log.
  - VLC finds the app folder from VLC's UTF-8 user folder (non-English Windows user names), retries a half-written
    heartbeat (the app also swaps it in atomically); second launch can bring the window to the front;
    tray menu ticks draw.
- **`python3 bench/run_all.py [--quick]`**: rebuilds the real-speech test films if missing and checks engine tests,
  VLC/browser parity, the VLC aligner (in sync, noisy, 3.2 s late, 2.1 s early, frame-rate drift) and the live browser
  aligner (clean, noisy, 1.5x, wrong text) against fixed limits. Needs mono, lua5.1, node, ffmpeg, onnxruntime (see the
  file header for the model/runtime paths).
- **`store/`**: Chrome Web Store kit: `listing.md` (copy, permission justifications, privacy answers),
  `privacy-policy.html` (replace SUPPORT_EMAIL, host it publicly), `THIRD_PARTY_NOTICES.txt` (also shipped in the
  extension), `images/` (4 screenshots 1280x800, promo tiles 440x280 and 1400x560; re-render with
  `node store/src/render.js` while serving the repo root on :8833).

## Faster sync that doesn't slow the computer down (0.6.6)

- **Never in the way:** while syncing, the app and its ffmpeg run at Windows' lowest priority (Idle), with low
  disk and memory priority and Windows 11's efficiency mode (EcoQoS), so a game, a browser or the film itself
  always comes first. The speech model no longer keeps cores busy-waiting between steps (`allow_spinning=0`):
  a third less CPU for the same speed.
- **The part you're watching first:** VLC sends the playback position; the app syncs from there to the end,
  shows those words as soon as that stretch is done (10-15 s after opening the film), then does the rest of the film.
- **Less work for the usual film:** a quick +-2 s search on 16 lines settles in-sync (and slightly shifted)
  subtitles, so the full +-15 s search only runs for big shifts or drift. Usual 12-minute film: 26.5 s -> ~20 s,
  peak memory 377 -> ~280 MB.
- **First words of a line** are placed 40 ms later (echoey rooms and 5.1 put them slightly early).
- **Browser:** live matching checks how long each step takes and listens less often on a slow computer
  (every 160 ms, up to 640 ms), instead of falling behind and keeping a core busy.
- **Browser, hard sound (echo, people talking over each other, noise):** the live follower used to stall when the
  model was unsure, so many words fell back to a late guess. Each next word now gets a small credit
  (`tokenBonus`), so it keeps up: first 4 minutes, echoey film 1.2 s -> 0.47 s late (words heard 32% -> 75%),
  the worst film 1.36 s -> 0.78 s, ordinary films 0.29 -> 0.26 s and 0.52 -> 0.31 s, early words still about 1% or less.
- **Hardening (found by fuzzing):** a numeric entity out of range (`&#99999999;`) crashed both subtitle readers;
  broken YouTube JSON crashed the browser reader; a time like `999999999:00:00` produced an unreadable words
  file for the app; non-English digits (٣, ३) crashed the app's word reader; a line with thousands of words (a file
  with missing blank lines) took 40 s in VLC (now revealed in up to 60 steps); an impossible offset in an
  alignment file was applied. All fixed, and the VLC script and browser engine now agree on 1,500 broken files.
- **Tests:** `python3 bench/run_all.py` now also fuzzes (1,500+ broken subtitle files through the browser engine,
  the VLC script and the app's word reader; the two engines must agree), runs six hard films (echo, cross-talk,
  5.1, fast, quiet, all at once), two small shifts (0.6 s, and 0.8 s on the echo film), a lag probe and the live
  follower on the hard films; `--soak` adds a 2-hour film. 27 checks.
- **Small shifts fixed:** subtitles 0.5-2 s off (common between releases) used to count as "in sync", leaving
  ~30% of words outside 0.1 s. A quick +-2 s search on 16 lines now finds them (0.6 s late: 69% -> 92% within
  0.1 s) and settles in-sync films on hard sound without the full search (echo film 58 s -> 24 s).

## Setup journey (0.7.0)

1. **Installer:** Welcome > Install > Finish (no components page; everything is installed). It starts the tray
   app in the background, registers `spoilaint://` and adds a Start menu entry *Add Spoilaint to your browser*.
   The finish page's ticked box, *Add Spoilaint to my browser now*, runs `Spoilaint.exe --add-extension`.
2. **Add-to-browser guide** (`tray/Guide.cs`, `tray/Browsers.cs`): a small always-on-top window in the bottom-right
   corner, so the viewer never switches windows. Finds Chrome, Brave and Edge (App Paths, then the usual folders;
   the default browser is picked first). *Open Chrome extensions* starts the browser with `chrome://extensions/`
   (pages can't link there, but the browser opens it when started with it) and copies the extension folder to
   the clipboard; then Developer mode > Load unpacked > Ctrl+V > Select Folder, or drag the folder tile onto the
   page. It ticks itself off when any extension `"path"` in a profile's `Secure Preferences`/`Preferences`
   points to a folder whose manifest.json is named Spoilaint (full folders for Load unpacked, `<id>\<version>`
   under the profile's Extensions folder for store installs), so a copy loaded from another folder (a dev build)
   counts too (polled every 1.5 s, cached by file time). Already added from another folder: it says where and
   offers *Switch to the installed copy* (then only the install folder counts).
3. **Welcome tab** (`extension/welcome.html`): opened once on install. Pin tip pointing at the toolbar, a looping
   preview of the reveal styles, how to use it per site (automatic / Sync to speech / delay keys), test page link.
4. **App window:** the browser step shows where it's added (detected) or an *Add to browser* button for the guide.
5. **Fallback page** `setup-extension.html` (install folder): buttons open the guide through `spoilaint://add-extension/<browser>`,
   plus the manual steps with a copy button.

App arguments: `--add-extension [chrome|brave|edge]`, `spoilaint://add-extension/<browser>`; a second instance
passes the request to the running one (`guide.req` + `Local\SpoilaintGuide` event).

## Windows setup window (0.8.0)

The installer has no NSIS pages any more. `installer/spoilaint.nsi` runs silently, copies `Spoilaint.exe` to
`%TEMP%\Spoilaint-setup-<version>.exe` and starts it with `--setup <dir> <version> <new|update> <installdir>`
(`tray/Setup.cs`): a borderless dark window with a live word-by-word demo, Install/Update, progress, and a finish
screen with *Add to my browser*. They talk through files in `$PLUGINSDIR`: the window writes `ui.ready`, then `go`
or `cancel`; NSIS writes `progress` ("percent|text") and `done` ("ok|vlcrunning|novlc|vlcerror" or "failed|...").
No window after 45 s: plain message boxes instead. If the installer disappears without `done`, the window judges by
whether `Spoilaint.exe` and the uninstaller are in place. Uninstall: one Yes/No box, then silent.

## macOS (0.8.0, not yet run on a Mac)

`mac/helper` is a Go port of the tray app (no cgo, so it cross-builds from Linux): `align.go` = `tray/Align.cs`
(output identical on the bench: rb1, 3.2 s late), `jobs.go` = the JobRunner (same job/result/heartbeat files),
ONNX Runtime through purego (`ort.go`). Its window is a local page (`ui/`, http://127.0.0.1:47821+) opened as a
Chrome/Brave/Edge `--app` window: setup (the Mac's installer screen), status, recent films, VLC settings, and the
add-to-browser guide (AppleScript opens chrome://extensions in a new window; folder copied with pbcopy; Cmd+Shift+G,
Cmd+V in the folder picker, or Show in Finder and drag). Detection reads the browsers' profiles like Windows.

- `Spoilaint.app` (in `Spoilaint-<v>-mac.dmg`): main program = the helper (universal arm64 + x86_64). Opening it
  copies its Resources to `~/Library/Application Support/Spoilaint/pending` (survives App Translocation), puts the
  helper in `.../bin`, writes the launch agent `~/Library/LaunchAgents/app.spoilaint.helper.plist` (`serve`), and
  opens the window; *Install* moves FFmpeg, the model, ONNX Runtime and the extension into place, copies the VLC
  script to `~/Library/Application Support/org.videolan.vlc/lua/intf/` and adds the two vlcrc lines in
  `~/Library/Preferences/org.videolan.vlc/vlcrc`.
- Syncs run at background QoS (`taskpolicy -b` for ffmpeg, PRIO_DARWIN_BG for the model).
- `vlc/spoilaint.lua` is cross-platform now: on macOS it uses `~/Library/Application Support/Spoilaint` and starts
  the helper with `launchctl kickstart` (Linux: `~/.local/share/Spoilaint`, used for testing with real VLC).
- Signed with a self-signed certificate (`mac/signing/`, keep it: a stable identity keeps macOS permissions across
  updates). Gatekeeper still asks once: System Settings > Privacy & Security > Open Anyway (see the DMG's read-me).
- Build (Linux): `node build.js && sh mac/build.sh` (needs `mac/vendor/`, listed at the top of `mac/build.sh`).
- Test helper on Linux: `cd mac/helper && go build -o /tmp/sh . && /tmp/sh aligntest MODEL film.mkv words.txt out.txt`.
