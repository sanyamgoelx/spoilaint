// node store/src/render.js  -> store/images/*.png (serve the repository root on :8833 first)
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 340, height: 800 }, deviceScaleFactor: 2 });
  await p.goto('http://localhost:8833/store/src/popup-shot.html');
  await p.waitForTimeout(800);
  const h = await p.evaluate(() => document.body.scrollHeight);
  await p.setViewportSize({ width: 340, height: h });
  await p.screenshot({ path: 'store/src/popup.png' });
  const shots = { 'screenshot-1-reveal': [1280, 800], 'screenshot-2-compare': [1280, 800], 'screenshot-3-sync': [1280, 800], 'screenshot-4-vlc': [1280, 800], 'promo-small-440x280': [440, 280], 'promo-marquee-1400x560': [1400, 560] };
  for (const [name, [w, hh]] of Object.entries(shots)) {
    const q = await b.newPage({ viewport: { width: w, height: hh }, deviceScaleFactor: 1 });
    await q.goto('http://localhost:8833/store/src/scenes.html#' + name);
    await q.waitForFunction(() => document.title === 'ready');
    await q.waitForTimeout(300);
    await q.screenshot({ path: 'store/images/' + name + '.png' });
    await q.close();
  }
  await b.close();
})();
