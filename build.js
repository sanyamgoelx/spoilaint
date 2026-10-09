// Builds the shippable pieces into dist/. Run: node build.js
//   dist/extension/   load this folder in chrome://extensions (Developer mode > Load unpacked)
//   dist/spoilaint-extension.zip   upload this to the Chrome Web Store
//   dist/vlc/spoilaint.lua
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = __dirname;
const dist = path.join(root, 'dist');
const ext = path.join(dist, 'extension');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(ext, 'icons'), { recursive: true });

const copy = (from, to) => fs.copyFileSync(path.join(root, from), path.join(dist, to));

// Extension: its own files + the shared engine and overlay + the test page.
['manifest.json', 'inject.js', 'content.js', 'popup.html', 'popup.css', 'popup.js', 'background.js', 'offscreen.html', 'offscreen.js', 'welcome.html', 'welcome.css', 'welcome.js', 'support.html', 'support.js'].forEach((f) => copy('extension/' + f, 'extension/' + f));
copy('engine/spoilaint-engine.js', 'extension/engine.js');
copy('engine/spoilaint-overlay.js', 'extension/overlay.js');
copy('engine/spoilaint-listen.js', 'extension/listen.js');
copy('engine/spoilaint-vad.js', 'extension/vad.js');
copy('engine/spoilaint-align.js', 'extension/align.js');
fs.copyFileSync(path.join(root, 'store/THIRD_PARTY_NOTICES.txt'), path.join(ext, 'THIRD_PARTY_NOTICES.txt'));
// Speech model (NeMo Conformer-CTC small, int8, from k2-fsa/sherpa-onnx; see installer/vendor/speech-model/README.txt).
const sm = path.join(root, 'installer/vendor/speech-model');
if (fs.existsSync(path.join(sm, 'model.int8.onnx'))) {
  fs.mkdirSync(path.join(ext, 'speech'), { recursive: true });
  ['model.int8.onnx', 'tokens.txt', 'README.txt'].forEach((f) => { if (fs.existsSync(path.join(sm, f))) fs.copyFileSync(path.join(sm, f), path.join(ext, 'speech', f)); });
} else console.warn('installer/vendor/speech-model is missing: the extension will use the voice detector instead');
copy('extension/pcm-worklet.js', 'extension/pcm-worklet.js');
fs.mkdirSync(path.join(ext, 'vad'), { recursive: true });
fs.readdirSync(path.join(root, 'extension/vad')).forEach((f) => copy('extension/vad/' + f, 'extension/vad/' + f));
copy('assets/upi-qr.svg', 'extension/upi-qr.svg');
[16, 32, 48, 128].forEach((s) => copy(`assets/icon-${s}.png`, `extension/icons/icon-${s}.png`));
const testHtml = fs.readFileSync(path.join(root, 'test-page/index.html'), 'utf8')
  .replace('../engine/spoilaint-engine.js', 'engine.js')
  .replace('../engine/spoilaint-overlay.js', 'overlay.js')
  .replace('../engine/spoilaint-listen.js', 'listen.js');
fs.writeFileSync(path.join(ext, 'test.html'), testHtml);
copy('test-page/test.js', 'extension/test.js');

// VLC script.
fs.mkdirSync(path.join(dist, 'vlc'), { recursive: true });
copy('vlc/spoilaint.lua', 'vlc/spoilaint.lua');

// Zip for the Web Store (needs `zip` on Linux/macOS, PowerShell on Windows).
const zipPath = path.join(dist, 'spoilaint-extension.zip');
try {
  if (process.platform === 'win32') {
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${ext}\\*' -DestinationPath '${zipPath}'"`);
  } else {
    execSync(`cd "${ext}" && zip -qr "${zipPath}" .`);
  }
} catch (e) {
  console.warn('Skipped the zip:', e.message);
}
console.log('Built', path.relative(root, dist));
