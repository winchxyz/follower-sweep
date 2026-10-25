// Builds what the Chrome Web Store asks for, into store/:
//   sweep-store.zip       the extension without the "key" field (the store assigns its own ID)
//   screenshot-*.png      1280x800 shots from the last `SHOT_HEIGHT=800 npm run e2e`
//   promo-small.png       440x280 small promo tile
//   promo-marquee.png     1400x560 marquee tile
// Needs PLAYWRIGHT_CORE for the tiles, like the e2e run.
import { cpSync, readdirSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store');
mkdirSync(OUT, { recursive: true });

// 1. zip without the key
const stage = join(tmpdir(), `sweep-store-${Date.now()}`);
cpSync(join(ROOT, 'extension'), stage, { recursive: true });
const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
delete manifest.key;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const zip = join(OUT, 'sweep-store.zip');
rmSync(zip, { force: true });
// bsdtar (Windows' own tar.exe) writes forward-slash paths; Git Bash's GNU tar can't write zips.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar';
execFileSync(tar, ['-a', '-c', '-f', zip, '-C', stage, ...readdirSync(stage)], { stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
console.log(`store/sweep-store.zip (version ${manifest.version}, no key)`);

// 2. screenshots
const shots = { '05-review.png': 'screenshot-1-review.png', '08-x-followers.png': 'screenshot-2-x-followers.png', '09-x-profile.png': 'screenshot-3-x-profile.png', '19-following.png': 'screenshot-4-following.png', '20-x-following.png': 'screenshot-5-x-following.png' };
for (const [from, to] of Object.entries(shots)) {
  const src = join(ROOT, 'dev', 'shots', from);
  if (existsSync(src)) copyFileSync(src, join(OUT, to));
}

// 3. promo tiles
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href);
const icon = 'data:image/png;base64,' + readFileSync(join(ROOT, 'extension', 'icons', '128.png')).toString('base64');
const tile = (w, h, big) => `<!doctype html><html><body style="margin:0"><div style="width:${w}px;height:${h}px;box-sizing:border-box;background:#151515;color:#f2f1ec;display:flex;align-items:center;gap:${big ? 56 : 22}px;padding:0 ${big ? 110 : 34}px;font-family:-apple-system,'Segoe UI',system-ui,sans-serif">
  <img src="${icon}" style="width:${big ? 200 : 96}px;height:${big ? 200 : 96}px;border-radius:${big ? 44 : 22}px;box-shadow:0 0 0 2px #2b2b29">
  <div><div style="font-size:${big ? 92 : 46}px;font-weight:800;letter-spacing:-0.04em;line-height:1">Sweep</div>
  <div style="font-size:${big ? 36 : 19}px;line-height:1.25;margin-top:${big ? 18 : 10}px;color:#d3d1ca">Clean dead followers<br>off your <span style="color:#ff6b4d;font-weight:700">X</span> account</div>
  ${big ? '<div style="font-size:24px;margin-top:26px;color:#97958e">Official API only · about $1 per 1,000 followers · free and open source</div>' : ''}</div></div></body></html>`;
const browser = await chromium.launch({ executablePath: join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe') });
for (const [name, w, h, big] of [['promo-small.png', 440, 280, false], ['promo-marquee.png', 1400, 560, true]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(tile(w, h, big));
  await page.screenshot({ path: join(OUT, name) });
}
await browser.close();
console.log('store/ screenshots and promo tiles written');
