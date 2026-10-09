# Changelog

## 0.8.1 (10 Oct 2026)

- *Support Spoilaint*: GitHub Sponsors and UPI, in the extension menu, the welcome tab, the Windows app (footer and tray menu) and the Mac window. Entirely optional.

## 0.8.0 (10 Oct 2026)

First public release.

**Windows 10/11:** `Spoilaint-Setup-0.8.0.exe` sets up VLC's word-by-word mode, a small background app, and walks you through adding the browser extension (about a minute). Windows SmartScreen may warn because the installer isn't code-signed yet: *More info* > *Run anyway*.

**macOS 11+ (Apple Silicon and Intel):** `Spoilaint-0.8.0-mac.dmg`. Drag to Applications, open it, then System Settings > Privacy & Security > *Open Anyway* the first time (not signed by an Apple developer account yet). This is the first Mac build and hasn't been run on a real Mac yet: please open an issue with what you see.

**Browser extension on its own:** `spoilaint-extension.zip` (unzip, then `chrome://extensions` > Developer mode > *Load unpacked*).

What's in 0.8.0:
- Words appear when they're spoken: a speech model running on your computer matches each subtitle word to the audio (VLC: whole film in the background; browser: live).
- VLC detects and fixes subtitle files that run early, late, or drift.
- New setup window on Windows, and an add-to-browser guide that opens the extensions page and copies the folder for you.
- First macOS build: the same background sync, settings window and browser guide.
