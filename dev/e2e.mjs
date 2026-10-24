// Loads the real extension in Chromium through Playwright, points it at the
// local X stub, and walks the whole thing: setup, sample mode, sign-in, scan,
// review, the three removal methods, and the x.com content script on stand-in
// pages. Screenshots land in dev/shots/.
//
//   PLAYWRIGHT_CORE=<path to playwright-core/index.mjs> node dev/e2e.mjs
//   (optional: CHROMIUM=<chrome.exe>, HEADED=1)
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startStubX } from './stub-x.mjs';
import { slimUser } from '../extension/lib/scan.js';
import { classify, normalizeRules } from '../extension/lib/rules.js';
import { avatarSvg } from '../extension/lib/demo.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const SHOTS = join(ROOT, 'dev', 'shots');
const EXPECTED_ID = 'ojfmjajpdhdpjekhnlmjpphmmmngochn';

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  for (const spec of [process.env.PLAYWRIGHT_CORE, 'playwright-core'].filter(Boolean)) {
    try {
      return await import(/[\\/]/.test(spec) ? pathToFileURL(spec).href : spec);
    } catch {}
  }
  throw new Error('playwright-core not found. Set PLAYWRIGHT_CORE to the path of playwright-core/index.mjs.');
}

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!existsSync(base)) return undefined;
  const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => b.split('-')[1] - a.split('-')[1]);
  for (const d of dirs) for (const sub of ['chrome-win64', 'chrome-win', 'chrome-linux']) {
    const exe = join(base, d, sub, sub.includes('win') ? 'chrome.exe' : 'chrome');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

// ---- stand-ins for x.com pages, using the same data-testid hooks as X's markup ----
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const FIX_CSS = `
  body { margin: 0; background: #fff; color: #0f1419; font: 15px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { display: flex; justify-content: center; }
  .col { width: 600px; min-height: 100vh; border-left: 1px solid #eff3f4; border-right: 1px solid #eff3f4; }
  .head { padding: 10px 16px; } .head b { display: block; font-size: 20px; } .head span { color: #536471; font-size: 13px; }
  .tabs { display: flex; border-bottom: 1px solid #eff3f4; } .tabs span { flex: 1; text-align: center; padding: 16px; color: #536471; font-weight: 600; }
  .tabs .on { color: #0f1419; box-shadow: inset 0 -4px 0 #1d9bf0; }
  .cell { all: unset; box-sizing: border-box; display: flex; gap: 12px; width: 100%; padding: 12px 16px; border-bottom: 1px solid #eff3f4; cursor: pointer; }
  .cell:hover { background: #f7f9f9; }
  .cell img { width: 40px; height: 40px; border-radius: 50%; display: block; }
  .body { flex: 1; min-width: 0; } .row1 { display: flex; justify-content: space-between; gap: 8px; }
  .nm { font-weight: 700; color: #0f1419; text-decoration: none; } .hd a { color: #536471; text-decoration: none; }
  .fy { background: #eff3f4; color: #536471; font-size: 12px; padding: 1px 4px; border-radius: 4px; margin-left: 4px; }
  .btns { display: flex; gap: 8px; align-items: center; } .more { color: #536471; font-size: 18px; padding: 0 6px; }
  .follow { border: 1px solid #cfd9de; border-radius: 999px; padding: 6px 16px; font-weight: 700; font-size: 14px; white-space: nowrap; }
  .bio { margin-top: 2px; }
  .banner { height: 200px; background: linear-gradient(120deg, #cfd9de, #e7ecf0); }
  .prof { padding: 12px 16px; position: relative; } .big { width: 134px; height: 134px; border-radius: 50%; border: 4px solid #fff; margin-top: -80px; display: block; }
  .acts { position: absolute; right: 16px; top: 12px; display: flex; gap: 8px; }
  [data-testid="UserName"] b { font-size: 20px; display: block; margin-top: 8px; } [data-testid="UserName"] .hd { color: #536471; }
  .meta { color: #536471; } .meta b { color: #0f1419; }
`;
// Stub avatars are plain http; serve them from the stand-in x.com so the https page shows them.
const pic = (u) => (u.profile_image_url?.includes('/avatar/') ? `https://x.com/__avatar/${u.id}.svg` : u.profile_image_url || `https://x.com/__avatar/${u.id}.svg`);
const extraPages = new Map(); // more stand-in pages, added as the run goes
const pageHtml = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${FIX_CSS}</style></head><body><main><div data-testid="primaryColumn" class="col">${body}</div></main></body></html>`;

function followersPage(list) {
  const rows = list.map((u) => `<div data-testid="cellInnerDiv"><div><button data-testid="UserCell" role="button" class="cell">
      <a href="/${u.username}" role="link"><img src="${esc(pic(u))}" alt=""></a>
      <div class="body"><div class="row1"><div><a href="/${u.username}" role="link" class="nm">${esc(u.name)}</a>
        <div class="hd"><a href="/${u.username}" role="link">@${u.username}</a><span data-testid="userFollowIndicator" class="fy">Follows you</span></div></div>
        <div class="btns"><span class="follow">${u.connection_status.includes('following') ? 'Following' : 'Follow back'}</span><span class="more">⋯</span></div></div>
        ${u.description ? `<div class="bio">${esc(u.description)}</div>` : ''}</div></button></div></div>`).join('');
  return pageHtml('People following Sample Account', `<div class="head"><b>Sample Account</b><span>@sample_account</span></div><div class="tabs"><span>Verified Followers</span><span class="on">Followers</span><span>Following</span></div><section>${rows}</section>`);
}

function profilePage(u) {
  return pageHtml(`${esc(u.name)} (@${u.username})`, `<div class="banner"></div><div class="prof"><img class="big" src="${esc(pic(u))}" alt="">
    <div class="acts"><span class="more">⋯</span><span class="follow">Follow back</span></div>
    <div data-testid="UserName"><b>${esc(u.name)}</b><div class="hd">@${u.username}<span data-testid="userFollowIndicator" class="fy">Follows you</span></div></div>
    <p>${esc(u.description)}</p><div class="meta"><b>${u.public_metrics.following_count}</b> Following &nbsp; <b>${u.public_metrics.followers_count}</b> Followers</div></div>`);
}

// ---- run ----
const { chromium } = await loadPlaywright();
const stub = await startStubX({ followers: 1250 });
mkdirSync(SHOTS, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'sweep-e2e-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findChromium(),
  headless: !process.env.HEADED,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 860 },
});

const errors = [];
try {
  let [sw] = ctx.serviceWorkers();
  sw ||= await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
  const id = new URL(sw.url()).host;
  check(id === EXPECTED_ID, `extension id is fixed by the manifest key (${id})`);

  const appUrl = `chrome-extension://${id}/app.html`;
  await sleep(800);
  let app = ctx.pages().find((p) => p.url().startsWith(appUrl));
  check(Boolean(app), 'installing opens Sweep\'s page');
  if (!app) {
    app = await ctx.newPage();
    await app.goto(appUrl);
  }
  app.on('dialog', (d) => d.accept());
  app.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // The stub's 403 for blocking is the expected answer; Chrome logs it as a failed load.
  app.on('console', (m) => m.type() === 'error' && !/status of 403/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await app.bringToFront();
  await app.evaluate((u) => chrome.storage.local.set({ dev: { authBase: u, apiBase: u } }), stub.url);
  const shot = (name, opts = {}) => app.screenshot({ path: join(SHOTS, name), ...opts });
  const store = () => app.evaluate(() => chrome.storage.local.get(null));

  // setup
  await app.waitForSelector('text=Connect Sweep to your own X developer app');
  const cb = await app.textContent('.copyrow code');
  check(cb === `https://${EXPECTED_ID}.chromiumapp.org/x`, `callback URI shown: ${cb}`);
  await shot('01-setup.png', { fullPage: true });

  // sample mode
  await app.click('text=Try it with sample followers');
  await app.waitForSelector('.summary .stat');
  const sampleRemove = Number((await app.textContent('.stat.rem .n')).replace(/,/g, ''));
  check(sampleRemove > 500, `sample mode shows followers to remove (${sampleRemove})`);
  check(await app.isDisabled('text=Open my Followers on X'), 'sample mode cannot open x.com');
  await shot('02-sample.png');
  await app.click('text=Leave sample');
  await app.waitForSelector('text=Connect Sweep to your own X developer app');

  // client id, sign-in
  await app.fill('input[name=clientId]', 'demo-client-id-123');
  await app.click('button:has-text("Save")');
  await app.waitForSelector('text=Sign in with X');
  await shot('03-connect.png');
  await app.click('button:has-text("Sign in with X")');
  await app.waitForSelector('text=Scan your', { timeout: 20_000 });
  check((await app.textContent('.top .handle')) === '@sample_account', 'signed in through the OAuth window');
  await shot('04-scan.png');

  // scan
  await app.click('button:has-text("Scan followers")');
  await app.waitForSelector('.summary .stat', { timeout: 30_000 });
  const rules = normalizeRules();
  const expected = stub.followers.map(slimUser).filter((u) => classify(u, rules, null).action === 'remove').length;
  const shown = Number((await app.textContent('.stat.rem .n')).replace(/,/g, ''));
  check(shown === expected, `"to remove" matches the rules: ${shown} vs ${expected}`);
  check(Number((await app.textContent('.stat .n')).replace(/,/g, '')) === 1250, 'all 1,250 followers scanned');
  await shot('05-review.png');
  await shot('05-review-full.png', { fullPage: true });

  // keep one by hand
  const firstName = await app.textContent('#list .u .hd');
  await app.click('#list .u button:has-text("Keep")');
  await app.waitForFunction(() => document.querySelector('[data-count="manual"]')?.textContent === '1');
  check(true, `kept ${firstName.split(' ')[0]} by hand`);

  // rule toggle changes the count
  await app.click('input[data-rule="keepFollowing"]');
  await app.waitForFunction((n) => Number(document.querySelector('.stat.rem .n').textContent.replace(/,/g, '')) > n, shown - 1);
  check(true, 'turning off "keep people you follow" raises the count');
  await app.click('input[data-rule="keepFollowing"]');

  // methods
  await app.click('button[data-method="queue"]');
  await app.waitForSelector('button:has-text("Start with @")');
  await (await app.$('.methods')).screenshot({ path: join(SHOTS, '06-queue.png') });
  await app.click('button[data-method="api"]');
  await app.click('button:has-text("Allow blocking")');
  await app.waitForSelector('button:has-text("Remove up to")', { timeout: 20_000 });
  await app.click('button:has-text("Remove up to")');
  await app.waitForSelector('text=Enterprise-only. Nobody was blocked', { timeout: 20_000 }).catch(() => {});
  const refused = await app.textContent('#api-status');
  check(/refused/.test(refused) && /Nobody was blocked/.test(refused), 'API mode stops at X\'s 403 and blocks nobody');
  check(stub.blocked.size === 0, 'stub saw no lasting block');
  await (await app.$('.methods')).screenshot({ path: join(SHOTS, '07-api-refused.png') });
  await app.click('button[data-method="page"]');

  // x.com content script on stand-in pages
  await sleep(600); // let the verdicts publish
  const data = await store();
  check(data.verdicts?.me === 'sample_account' && Object.keys(data.verdicts.map).length === 1250, 'verdicts published for the content script');
  await ctx.route('https://x.com/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (extraPages.has(path)) return route.fulfill({ contentType: 'text/html', body: extraPages.get(path) });
    const av = /^\/__avatar\/(\d+)\.svg$/.exec(path);
    if (av) return route.fulfill({ contentType: 'image/svg+xml', body: avatarSvg(av[1]) });
    if (path === '/sample_account/followers') return route.fulfill({ contentType: 'text/html', body: followersPage(stub.followers.slice(0, 40)) });
    const u = stub.followers.find((f) => `/${f.username}` === path);
    return u ? route.fulfill({ contentType: 'text/html', body: profilePage(u) }) : route.fulfill({ status: 404, body: 'not here' });
  });
  await ctx.route(/https:\/\/(abs|pbs)\.twimg\.com\/.*/, (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#cfd9de"/><circle cx="24" cy="19" r="8" fill="#fff"/><path d="M8 48c2-11 9-16 16-16s14 5 16 16z" fill="#fff"/></svg>' }));

  const xp = await ctx.newPage();
  xp.on('pageerror', (e) => errors.push(`x pageerror: ${e.message}`));
  await xp.goto('https://x.com/sample_account/followers');
  await xp.waitForSelector('[data-testid="UserCell"][data-sweep]');
  const marks = await xp.$$eval('[data-testid="UserCell"]', (cells) => cells.map((c) => c.dataset.sweep));
  const want = stub.followers.slice(0, 40).map((u) => {
    const v = data.verdicts.map[u.username.toLowerCase()];
    return v[1] === 'r' ? 'remove' : v[1] === 'd' ? 'done' : 'keep';
  });
  check(JSON.stringify(marks) === JSON.stringify(want), `every follower row is marked (${marks.filter((m) => m === 'remove').length} red, ${marks.filter((m) => m === 'keep').length} green)`);
  check(Boolean(await xp.$('#sweep-ui')), 'Followers page shows the Sweep bar');
  await xp.screenshot({ path: join(SHOTS, '08-x-followers.png') });

  const [handle, fid] = data.queue[0];
  await xp.goto(`https://x.com/${handle}`);
  await xp.waitForSelector('#sweep-ui');
  await sleep(700);
  await xp.screenshot({ path: join(SHOTS, '09-x-profile.png') });
  await xp.evaluate(() => document.querySelector('[data-testid="userFollowIndicator"]').remove()); // what X does after "Remove this follower"
  await sleep(2600);
  const rm = (await store())[`rm:${fid}`];
  check(rm?.via === 'detected', `removal on the profile is noticed (@${handle})`);
  await xp.screenshot({ path: join(SHOTS, '10-x-profile-removed.png') });
  await xp.click('#sweep-ui >> button:has-text("Next")');
  await xp.waitForURL((u) => u.pathname !== `/${handle}`);
  check(new URL(xp.url()).pathname === `/${data.queue[1][0]}`, `Next goes to @${data.queue[1][0]}`);

  // back in Sweep
  await app.bringToFront();
  await app.click('button[data-view="done"]');
  await app.waitForSelector('#list .u');
  check((await app.textContent('button[data-view="done"] .cnt')) === '1', 'Removed tab lists it');
  await shot('11-removed.png');

  // Following side: scan who you follow, mark x.com's Following page, notice an unfollow
  await app.click('button[data-side="following"]');
  await app.click('button:has-text("Scan who I follow")');
  await app.waitForSelector('#fsummary .stat', { timeout: 30_000 });
  const notBack = Number((await app.textContent('#fsummary .stat.rem .n')).replace(/,/g, ''));
  check(notBack === 25, `Following shows who doesn't follow back (${notBack})`);
  await shot('19-following.png');
  await sleep(600);
  const g = await store();
  const friends = Object.entries(g.verdicts.gmap).filter(([, v]) => v[1] === 'n').slice(0, 6);
  const mutuals = Object.entries(g.verdicts.gmap).filter(([, v]) => v[1] === 'b').slice(0, 6);
  const fake = ([handle, v]) => ({ id: v[0], username: handle, name: handle, profile_image_url: '', description: '', public_metrics: { followers_count: 3, following_count: 900 } });
  const fixtureUser = ([handle, v]) => stub.followers.find((f) => f.id === v[0]) || fake([handle, v]);
  extraPages.set('/sample_account/following', pageHtml('People followed by Sample Account', [...friends, ...mutuals].map((e) => {
    const u = fixtureUser(e);
    return `<div data-testid="cellInnerDiv"><button data-testid="UserCell" role="button" class="cell"><a href="/${e[0]}" role="link"><img src="${esc(pic(u))}" alt=""></a>
      <div class="body"><div class="row1"><div><a href="/${e[0]}" role="link" class="nm">${esc(u.name)}</a><div class="hd"><a href="/${e[0]}" role="link">@${e[0]}</a></div></div>
      <div class="btns"><span class="follow" data-testid="${e[1][0]}-unfollow">Following</span></div></div></div></button></div>`;
  }).join('')));
  const [fh, fv] = friends[0];
  extraPages.set(`/${fh}`, pageHtml(`@${fh}`, `<div class="banner"></div><div class="prof"><div class="acts"><span class="follow" data-testid="${fv[0]}-unfollow">Following</span></div>
    <div data-testid="UserName"><b>${esc(fh)}</b><div class="hd">@${fh}</div></div></div>`));
  await xp.goto('https://x.com/sample_account/following');
  await xp.waitForSelector('[data-testid="UserCell"][data-sweep]');
  const gm = await xp.$$eval('[data-testid="UserCell"]', (cells) => cells.map((c) => c.dataset.sweep));
  check(gm.slice(0, 6).every((m) => m === 'remove') && gm.slice(6).every((m) => m === 'keep'), `Following page rows marked (${gm.join(' ')})`);
  await xp.screenshot({ path: join(SHOTS, '20-x-following.png') });
  await xp.goto(`https://x.com/${fh}`);
  await xp.waitForSelector('#sweep-ui');
  await sleep(700);
  await xp.evaluate((id) => { document.querySelector(`[data-testid="${id}-unfollow"]`).dataset.testid = `${id}-follow`; }, fv[0]); // what X does after Unfollow
  await sleep(2600);
  check((await store())[`uf:${fv[0]}`]?.via === 'detected', `unfollow on the profile is noticed (@${fh})`);
  await xp.screenshot({ path: join(SHOTS, '21-x-following-profile.png') });
  await app.bringToFront();
  await app.click('button[data-side="followers"]');

  await app.click('button[data-view="remove"]');
  await app.emulateMedia({ colorScheme: 'dark' });
  await sleep(200);
  await shot('12-review-dark.png');
  await app.emulateMedia({ colorScheme: 'light' });

  await app.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const overflow = await app.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `no sideways scroll at phone width (${overflow}px)`);
  await shot('13-review-phone.png');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  failures.push(e.message);
  console.error(e);
} finally {
  await ctx.close();
  await stub.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
