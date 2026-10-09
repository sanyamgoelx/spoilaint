# Chrome Web Store submission: Spoilaint

Everything to paste into the Chrome Web Store developer dashboard (https://chrome.google.com/webstore/devconsole).
Upload `dist/spoilaint-extension.zip`. One-time developer registration fee: US$5.

## Store listing tab

**Name** (from the manifest): Spoilaint: spoiler-free subtitles

**Summary** (manifest description, max 132 characters, currently 128):
Subtitles that keep up, never run ahead: words appear as they're spoken. Netflix, YouTube, Hotstar, SonyLIV and more.

**Category:** Accessibility  *(alternative: Entertainment)*

**Language:** English

**Description:**

Ever read the twist in the subtitles before the actor says it? Spoilaint fixes that.

Spoilaint shows subtitles word by word, as they're spoken. A line never gives away its punchline, its confession or its reveal before the moment arrives, and you still get every word.

HOW IT WORKS
• Works with the subtitles you already have on: Netflix, YouTube, JioHotstar, SonyLIV, Prime Video and most other video sites.
• A small speech model, running entirely on your computer, listens to the dialogue and shows each word when it's actually spoken. No audio ever leaves your computer.
• On sites that protect their sound (Netflix, Prime Video, Hotstar), press Alt+S, or click "Sync to speech", once per viewing to let Spoilaint hear the tab. On YouTube and most other sites it just works.
• If the subtitles don't match what's being said (a dubbed version, for example), Spoilaint notices and switches to estimated timing by itself.

MAKE IT YOURS
• Word by word, or three words at a time
• Delay control: Alt+[ and Alt+] while watching
• Text size, shadow or box background, and a highlight colour for the newest word
• Turn it off on any site with one click

PRIVATE BY DESIGN
• No account, no tracking, no analytics, no servers. Everything runs on your computer.
• Your settings are stored in Chrome (synced with your Google account if you use Chrome sync).

ALSO FOR VLC
The free Spoilaint app for Windows brings the same spoiler-free subtitles to VLC, including subtitles built into .mkv files and subtitle files that are out of sync with the film.

Credits: speech model NVIDIA NeMo Conformer-CTC small (CC BY 4.0), converted by the sherpa-onnx project; ONNX Runtime Web (MIT); Silero VAD (MIT).

**Screenshots** (1280×800): `store/images/screenshot-1-reveal.png` … `screenshot-4-anywhere.png`
**Small promo tile** (440×280): `store/images/promo-small-440x280.png`
**Marquee promo tile** (1400×560, optional): `store/images/promo-marquee-1400x560.png`
**Store icon** (128×128): `assets/icon-128.png`

**Official URL / Homepage:** your Statix or Spoilaint page once there is one *(optional)*
**Support URL:** an email address or page for feedback *(optional)*

## Privacy practices tab

**Single purpose:**
Spoilaint shows the subtitles of the video you're watching word by word, as each word is spoken, so a subtitle line never reveals what hasn't been said yet.

**Permission justifications:**

| Permission | Justification to paste |
|---|---|
| `storage` | Saves the viewer's display settings (reveal style, delay, text size, colours, sites where it's turned off). |
| `activeTab` | Lets the toolbar popup and the Alt+S shortcut act on the tab the viewer is looking at: show its subtitle status and start listening to it when asked. |
| `tabCapture` | When the viewer clicks "Sync to speech" (or presses Alt+S) on a site that hides its sound from web pages, the tab's audio is captured so the on-device speech model can tell when each subtitle word is spoken. Audio is processed locally in memory and never stored or sent anywhere. Capture stops when the viewer stops it or leaves the site. |
| `offscreen` | Runs the audio processing and the on-device speech model in a hidden extension page, and keeps the captured tab audible while it is being listened to. |
| Host permissions (content scripts on `http://*/*`, `https://*/*`) | Subtitles can come from any video site. The content script finds the playing video and its subtitles (the subtitle file the player loads, its text track, or the on-screen captions), hides the site's own subtitles and draws the word-by-word version. It does nothing on pages without a video with subtitles, and can be turned off per site. |

**Remote code:** No, I am not using remote code. (The speech model and the WebAssembly runtime are packaged inside the extension.)

**Data usage:** Spoilaint does not collect or transmit any user data. Tick none of the data categories. Then confirm:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** host `store/privacy-policy.html` somewhere public (for example a GitHub Pages site or a page on your website) and paste its URL here.

## After it's published

1. Put the store link into `installer/spoilaint.nsi` (`!define STORE_URL "https://chromewebstore.google.com/detail/..."`), so the installer's last step opens the store page instead of the developer-mode guide.
2. Update `installer/setup-extension.html` and the app's "Show me how" step to point at the store.
3. Reviews usually take a few days. `tabCapture` and all-sites access can mean a closer look, and the justifications above cover what reviewers ask.
