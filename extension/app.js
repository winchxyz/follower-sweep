// Sweep's page: holds the state, renders it, and runs the scan and the optional
// API removal. Everything that talks to X goes through lib/xapi.js.
import { chromeStore, withPrefix } from './lib/store.js';
import { createXApi, explainError, X_AUTH_BASE, X_API_BASE } from './lib/xapi.js';
import { createScanner, loadFollowers, saveFollowers, slimUser } from './lib/scan.js';
import { createApiRemover, API_DEFAULTS } from './lib/apiremove.js';
import { normalizeRules, classify, reasonText, checkKind, lastPostAt, prepare, SORTS } from './lib/rules.js';
import { sampleFollowers, SAMPLE_ME } from './lib/demo.js';
import { esc, fmtInt, fmtCompact, fmtUsd, fmtDuration, ago, clampInt } from './lib/util.js';

const store = chromeStore();
const REDIRECT = chrome.identity.getRedirectURL('x');
const OWNED_READ = 0.001; // USD per account on X pay-per-use when the app is yours
const OTHER_READ = 0.01;
const PAGE = 150;
const HAND_SECONDS = 10; // rough time to remove one follower by hand on x.com

const loopback = (u) => typeof u === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u);
// Test hook: dev/e2e.mjs points Sweep at a local stub of X. Only loopback addresses are honoured.
async function getBases() {
  const dev = await store.get('dev');
  return {
    authBase: loopback(dev?.authBase) ? dev.authBase : X_AUTH_BASE,
    apiBase: loopback(dev?.apiBase) ? dev.apiBase : X_API_BASE,
  };
}

const x = createXApi({ store, redirectUri: REDIRECT, getBases, launchAuth: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }) });
const scanner = createScanner({ x, store, onUpdate: () => schedule() });
const remover = createApiRemover({ x, store, onUpdate: () => schedule() });

const S = {
  loaded: false, editingApp: false, busy: '', flash: null,
  app: null, auth: null, me: null, fmeta: null, partial: null, demo: false, reconcile: null,
  users: [], byId: new Map(), keep: new Map(), removed: new Map(), pend: new Map(),
  rules: normalizeRules(), cfg: { dimKeepers: true, method: 'page', reconcileSeen: 0, ...API_DEFAULTS },
  view: 'remove', q: '', sort: 'dead', limit: PAGE,
};
let D = { version: 0, cls: new Map(), remove: [], keep: [], counts: { total: 0, keep: 0, remove: 0, reasons: {}, kinds: {} } };

// ---------- data ----------

async function loadAll() {
  const got = await store.getMany(['app', 'auth', 'me', 'fmeta', 'rules', 'cfg', 'demo', 'lastReconcile', 'scan']);
  S.app = got.app || null;
  S.auth = got.auth || null;
  S.mode = S.auth ? 'user' : S.app?.bearer ? 'app' : null;
  S.me = got.me || null;
  S.fmeta = got.fmeta || null;
  S.rules = normalizeRules(got.rules);
  S.cfg = { ...S.cfg, ...(got.cfg || {}) };
  S.demo = got.demo === true;
  S.reconcile = got.lastReconcile || null;
  S.partial = got.scan || null;
  S.users = prepare(await loadFollowers(store));
  S.byId = new Map(S.users.map((u) => [u.id, u]));
  await loadMarks();
  S.loaded = true;
}

async function loadMarks() {
  [S.removed, S.keep, S.pend] = await Promise.all([withPrefix(store, 'rm:'), withPrefix(store, 'keep:'), withPrefix(store, 'pend:')]);
  derive();
}

function derive() {
  const now = Date.now();
  const cls = new Map(), remove = [], keep = [];
  const counts = { total: S.users.length, keep: 0, remove: 0, silent: 0, reasons: {}, kinds: { blue: 0, business: 0, government: 0 } };
  // The inactivity rule shows how many accounts it catches: silent for N+ days and not kept by the other rules.
  const otherRules = { ...S.rules, inactiveOn: false };
  const silentFor = S.rules.inactiveDays * 86_400_000;
  for (const u of S.users) {
    const c = classify(u, S.rules, S.keep, now);
    cls.set(u.id, c);
    if (S.removed.has(u.id)) continue;
    if (classify(u, otherRules, S.keep, now).action === 'remove') {
      const last = lastPostAt(u);
      if (u.posts === 0 || (last != null && now - last >= silentFor)) counts.silent++;
    }
    if (c.action === 'remove') {
      remove.push(u);
      counts.remove++;
      continue;
    }
    keep.push(u);
    counts.keep++;
    counts.reasons[c.reason] = (counts.reasons[c.reason] || 0) + 1;
    if (c.reason === 'verified') counts.kinds[checkKind(u)]++;
  }
  D = { version: D.version + 1, cls, remove, keep, counts };
  publishSoon();
}

const saveCfg = () => store.set('cfg', S.cfg);
const blockScope = () => (S.auth?.scope || '').split(/\s+/).includes('block.write');
// Your own sign-in reads your followers as owned reads; the app's Bearer Token pays the normal rate.
// Measured 2026-10-24: X billed a Bearer-token scan of the owner's own followers as owned reads too.
const readPrice = () => OWNED_READ;
const queueOrder = () => [...D.remove].sort(SORTS.dead.cmp);

// What the x.com content script needs: a verdict per handle and the removal order.
let publishTimer = 0;
function publishSoon() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(publish, 250);
}
async function publish() {
  if (S.demo || !S.me || !S.fmeta || S.fmeta.userId !== S.me.id) {
    await store.remove(['verdicts', 'queue']);
    return;
  }
  const map = {};
  for (const u of S.users) {
    const c = D.cls.get(u.id);
    const code = S.removed.has(u.id) ? 'd' : c.action === 'remove' ? 'r' : 'k';
    map[u.username.toLowerCase()] = [u.id, code, c.reason, u.followers, verdictLabel(u, c, code)];
  }
  const queue = queueOrder().map((u) => [u.username.toLowerCase(), u.id]);
  await store.setMany({ verdicts: { me: S.me.username.toLowerCase(), at: Date.now(), map }, queue });
}
function verdictLabel(u, c, code) {
  if (code === 'd') return 'Marked removed';
  if (code === 'k') return `Keep · ${reasonText(c, u, S.rules)}`;
  const hints = u._sig.filter((s) => s.key !== 'tiny').slice(0, 2).map((s) => s.label);
  return ['Remove', `${fmtCompact(u.followers)} follower${u.followers === 1 ? '' : 's'}`, ...hints].join(' · ');
}

let marksTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !S.loaded) return;
  const keys = Object.keys(changes);
  if (keys.some((k) => /^(rm|keep|pend):/.test(k))) {
    clearTimeout(marksTimer);
    marksTimer = setTimeout(async () => {
      await loadMarks();
      schedule();
    }, 120);
  }
  if (changes.lastReconcile) S.reconcile = changes.lastReconcile.newValue || null;
});

async function wipeData(keep = ['app', 'dev']) {
  const keys = (await store.keys()).filter((k) => !keep.includes(k));
  if (keys.length) await store.remove(keys);
}

// ---------- rendering ----------

const $ = (sel) => document.querySelector(sel);
function patch(el, html) {
  if (el && el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }
}
let raf = 0;
function schedule() {
  if (!raf) raf = requestAnimationFrame(() => {
    raf = 0;
    render();
  });
}
setInterval(() => {
  if (scanner.status.running || remover.status.running) schedule();
}, 1000);

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#151515"/><path d="M23.2 5.4 16 15.4" stroke="#f3f2ee" stroke-width="2.6" stroke-linecap="round"/><path d="M12.6 13.3 18.6 17.6 14.3 26.8 5.3 20.3Z" fill="#e4472a"/><path d="M14.4 16.1 10 22.7M16.6 17.7 12.5 24.7" stroke="#151515" stroke-width="1.3" stroke-linecap="round"/></svg>`;
const KIND_NAME = { blue: 'X Premium', business: 'Verified business', government: 'Government' };
const CHECK = (kind) => `<svg class="ck ${kind}" viewBox="0 0 16 16" role="img" aria-label="${KIND_NAME[kind]}"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M4.7 8.2 7 10.5l4.3-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const LOCK = `<svg class="lock" viewBox="0 0 16 16" role="img" aria-label="Protected account"><path d="M4.8 7V5.4a3.2 3.2 0 0 1 6.4 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3.2" y="7" width="9.6" height="7.4" rx="1.8" fill="currentColor"/></svg>`;

const SAFE_IMG = /^(https:\/\/(pbs|abs)\.twimg\.com\/|data:image\/svg\+xml|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)/;
function avatar(url, size, label) {
  const cls = `av${size ? ' ' + size : ''}`;
  if (!url || !SAFE_IMG.test(url)) return `<span class="${cls} ph" aria-hidden="true">${esc((label || '?').slice(0, 1).toUpperCase())}</span>`;
  const src = url.includes('default_profile_images') ? 'icons/default-avatar.svg' : url.replace('_normal.', size === 'lg' ? '_200x200.' : '_bigger.');
  return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
}
function profile(username, inner) {
  if (S.demo) return `<span>${inner}</span>`;
  return `<a href="https://x.com/${encodeURIComponent(username)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}
const notice = (kind, html, actions = '') => `<div class="notice ${kind}"><p>${html}</p>${actions}</div>`;
const plural = (n, one, many = one + 's') => `${fmtInt(n)} ${n === 1 ? one : many}`;

function screenName() {
  if (!S.loaded) return 'loading';
  if (S.demo) return 'review';
  if ((!S.app?.clientId && !S.app?.bearer) || S.editingApp) return 'setup';
  if (scanner.status.running) return 'scan';
  if (S.fmeta && (!S.me || S.fmeta.userId === S.me.id)) return 'review';
  return S.mode && S.me ? 'scan' : 'connect';
}

function render() {
  const sc = screenName();
  patch($('#top'), topHtml());
  patch($('#notice'), noticeHtml(sc));
  const main = $('#screen');
  if (main.dataset.screen !== sc) {
    main.dataset.screen = sc;
    main.innerHTML = FRAME[sc]();
    main.__html = null;
  }
  FILL[sc]?.();
  patch($('#foot'), sc === 'loading' ? '' : footHtml(sc));
}

function topHtml() {
  let right = '';
  if (S.demo) right = '<span class="chip-demo">Sample data</span>';
  else if (S.me) right = `${avatar(S.me.avatar, 'sm', S.me.username)}<span class="handle">@${esc(S.me.username)}</span>${S.mode === 'app' ? '<span class="muted">app token</span>' : S.auth ? '' : '<span class="muted">signed out</span>'}`;
  return `<div class="wrap top-in"><div class="brand">${LOGO}<span class="word">Sweep</span><span class="tag">follower cleanup for X, within X's rules</span></div><div class="acct">${right}</div></div>`;
}

function noticeHtml(sc) {
  const out = [];
  if (S.demo) out.push(notice('warn', `<b>Sample mode.</b> These ${fmtInt(S.users.length)} followers are made up and nothing here touches X.`, '<button class="btn sm" data-act="leave-sample">Leave sample</button>'));
  if (S.flash) out.push(notice(S.flash.kind, S.flash.html, '<button class="btn sm" data-act="dismiss">Dismiss</button>'));
  if (S.pend.size && !remover.status.running) {
    out.push(notice('err', `${plural(S.pend.size, 'account is', 'accounts are')} still blocked from an automatic run that was cut short.`, '<button class="btn sm" data-act="api-release">Unblock now</button>'));
  }
  if (sc === 'review' && !S.demo) {
    const st = scanner.status;
    const resume = '<button class="btn sm" data-act="scan">Resume re-scan</button>';
    if (st.phase === 'error') out.push(notice('err', esc(st.error), resume));
    else if (st.phase === 'paused') out.push(notice('warn', esc(st.message), resume));
    else if (S.partial && S.partial.userId === S.me?.id) out.push(notice('warn', `A re-scan stopped after ${plural(S.partial.count, 'follower')}.`, resume));
    const r = S.reconcile;
    if (r && r.at !== S.cfg.reconcileSeen && (r.confirmed || r.back)) {
      const parts = [];
      if (r.confirmed) parts.push(`${plural(r.confirmed, 'removal')} confirmed`);
      if (r.back) {
        const names = r.names.map((n) => '@' + esc(n)).join(', ') + (r.back > r.names.length ? ', …' : '');
        parts.push(`${plural(r.back, 'account')} you marked as removed still follow you (${names}), so they are back on the list`);
      }
      out.push(notice(r.back ? 'warn' : 'ok', `Re-scan: ${parts.join('. ')}.`, '<button class="btn sm" data-act="seen-reconcile">OK</button>'));
    }
  }
  return out.join('');
}

const FRAME = {
  loading: () => '<p class="loading">Loading…</p>',

  setup: () => `
<section class="card step">
  <p class="eyebrow">Set up · 1 of 3</p>
  <h1>Connect Sweep to your own X developer app</h1>
  <p class="lede">Sweep reads your followers through the official X API, the only way X lets a tool read them. That needs a developer app of your own; setting one up takes about five minutes.</p>
  <ol class="steps">
    <li><b>Open <a href="https://console.x.com" target="_blank" rel="noopener noreferrer">console.x.com</a></b> signed in as the account you want to clean up.
      <span class="sub">Then reading your own followers bills as "owned reads", $0.001 per account. An app that belongs to another account pays $0.010 per account.</span></li>
    <li><b>Create an app</b> and open its <b>User authentication settings</b>. Choose <b>OAuth 2.0</b>, app type <b>Native App</b>, permission <b>Read</b>.</li>
    <li><b>Callback URI</b>, exactly:
      <div class="copyrow"><code>${esc(REDIRECT)}</code><button class="btn sm" type="button" data-act="copy" data-text="${esc(REDIRECT)}">Copy</button></div>
      <span class="sub">For Website URL any page of yours works, your X profile for example.</span></li>
    <li><b>Billing:</b> buy a few dollars of credit and set a spending limit. Scanning 10,000 followers costs about $10.</li>
    <li><b>Paste the Client ID</b> from the app's <b>Keys and tokens</b> page.
      <form data-form="app" autocomplete="off">
        <div class="form">
          <input class="field" name="clientId" placeholder="OAuth 2.0 Client ID" spellcheck="false" value="${esc(S.app?.clientId || '')}" aria-label="Client ID">
          <button class="btn primary big" type="submit">Save</button>
          ${S.editingApp ? '<button class="btn big" type="button" data-act="cancel-edit">Cancel</button>' : ''}
        </div>
        <details${S.app?.clientSecret ? ' open' : ''}><summary>Chose "Web App" instead of "Native App"?</summary>
          <p class="fine">Then X also wants the Client Secret. It stays in this browser's extension storage.</p>
          <div class="form"><input class="field" name="clientSecret" type="password" placeholder="Client Secret (Web App only)" value="${esc(S.app?.clientSecret || '')}" aria-label="Client Secret"></div>
        </details>
      </form>
    </li>
  </ol>
  ${S.auth ? '' : '<div class="alt"><span>Want to look around first?</span><button class="btn" data-act="sample">Try it with sample followers</button></div>'}
</section>`,

  connect: () => `
<section class="card step">
  <p class="eyebrow">Set up · 2 of 3</p>
  <h1>Sign in with X</h1>
  <p class="lede">A window from x.com asks you to let your app read your profile and the accounts that follow you. Sweep never sees your password, and you can revoke access any time under Connected apps in X's settings.</p>
  <div class="cta" id="cta"></div>
  <p class="fine scopes">Permissions asked: read profiles and posts (tweet.read, users.read), read follows (follows.read), stay signed in (offline.access). Nothing that can post, follow or block.</p>
  <details class="alt-auth"${S.app?.bearer ? ' open' : ''}>
    <summary>X keeps refusing the sign-in? Use your app's Bearer Token instead</summary>
    <p class="fine">Sweep then reads your followers with the app's own token and no sign-in, so X's sign-in problem doesn't get in the way. When the app belongs to the account you scan, X bills these as owned reads too, $0.001 per follower. Automatic removal needs the sign-in and stays off. The token stays in this browser.</p>
    <ol class="fine mini">
      <li>In console.x.com open your app, then <b>Keys and tokens</b>, then <b>Bearer Token</b>: <b>Generate</b> (or <b>Regenerate</b>). Copy it right away; X shows it once.</li>
      <li>Paste it here with your @handle.</li>
    </ol>
    <form data-form="bearer" autocomplete="off">
      <div class="form">
        <input class="field short" name="handle" placeholder="@yourhandle" spellcheck="false" value="${esc(S.app?.handle ? '@' + S.app.handle : '')}" aria-label="Your X handle">
        <input class="field" name="bearer" type="password" placeholder="Bearer Token" aria-label="Bearer Token">
        <button class="btn primary big" type="submit">Use token</button>
      </div>
    </form>
  </details>
  <div class="alt"><span>Not ready to connect?</span><button class="btn" data-act="sample">Try it with sample followers</button></div>
</section>`,

  scan: () => '<section class="card step"><p class="eyebrow">Set up · 3 of 3</p><div id="scanbox"></div></section>',

  review: () => `
<section id="summary" class="summary"></section>
<div class="review">
  <aside class="card rules">${rulesHtml()}</aside>
  <div class="work">
    <section class="card methods"><div class="mtabs" id="mtabs" role="tablist" aria-label="How to remove"></div><div class="mbody" id="mbody"></div></section>
    <section class="card listcard">
      <div class="listbar">
        <div class="tabs" id="tabs" role="tablist" aria-label="List"></div>
        <div class="tools">
          <input id="q" class="search" type="search" placeholder="Search name, @handle or bio" value="${esc(S.q)}" aria-label="Search">
          <select id="sort" class="sel" aria-label="Sort">${Object.entries(SORTS).map(([k, s]) => `<option value="${k}"${k === S.sort ? ' selected' : ''}>${s.label}</option>`).join('')}</select>
          <button class="btn" data-act="export">Export CSV</button>
        </div>
      </div>
      <div id="list"></div>
    </section>
  </div>
</div>`,
};

const FILL = {
  connect() {
    patch($('#cta'), S.busy === 'connect'
      ? '<button class="btn primary big" disabled>Waiting for X…</button>'
      : '<button class="btn primary big" data-act="connect">Sign in with X</button><button class="linkbtn" data-act="edit-app">Change Client ID</button>');
  },
  scan() {
    patch($('#scanbox'), scanBoxHtml());
  },
  review() {
    patch($('#summary'), summaryHtml());
    updateCounts();
    patch($('#mtabs'), mtabsHtml());
    patch($('#mbody'), mbodyHtml());
    patch($('#api-status'), apiStatusHtml());
    patch($('#tabs'), tabsHtml());
    patch($('#list'), listHtml());
  },
};

function scanBoxHtml() {
  const st = scanner.status;
  const me = S.me;
  const n = st.expected || me?.followers || 0;
  const head = me ? `<div class="me">${avatar(me.avatar, 'lg', me.username)}<div><b>${esc(me.name)}</b><span>@${esc(me.username)} · ${fmtInt(me.followers)} followers</span></div></div>` : '';
  if (st.running) {
    const pct = n ? Math.min(100, (st.found / n) * 100) : 0;
    const secs = st.waitUntil ? ` (${Math.max(0, Math.ceil((st.waitUntil - Date.now()) / 1000))} s)` : '';
    const phase = st.phase === 'following' ? 'Checking whom you follow back' : st.phase === 'profile' ? 'Reading your profile' : 'Reading followers';
    return `${head}<h1>Scanning your followers</h1>
      <div class="progress"><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <p class="pmeta"><b>${fmtInt(st.found)}</b> of about ${fmtInt(n)} read · ${esc(st.message || phase)}${secs}</p>
        <p class="pmeta muted">About ${fmtUsd(st.reads * readPrice())} so far${S.mode === 'app' ? '' : ' at the owned-read rate'}. Closing this tab pauses the scan; it picks up where it stopped.</p>
        <div class="cta"><button class="btn" data-act="pause-scan">Pause</button></div></div>`;
  }
  const partial = S.partial && me && S.partial.userId === me.id ? S.partial : null;
  const problem = st.phase === 'error' ? notice('err', esc(st.error)) : st.phase === 'paused' ? notice('warn', esc(st.message)) : '';
  // With the app token X can't say whom you follow back, so Sweep also reads your following list.
  const viaApp = S.mode === 'app';
  const reads = n + (viaApp ? me?.following || 0 : 0);
  const price = viaApp ? ` for about ${fmtUsd(reads * readPrice())}` : '';
  const start = partial
    ? `<button class="btn primary big" data-act="scan">Resume scan (${fmtInt(partial.count)} read)</button><button class="linkbtn" data-act="scan-fresh">Start over</button>`
    : `<button class="btn primary big" data-act="scan">Scan followers${price}</button>`;
  const cheaper = viaApp
    ? notice('', 'You\'re reading with the app\'s Bearer Token. Scanning works the same; only automatic removal needs your own sign-in.', '<button class="btn sm" data-act="connect">Try Sign in with X</button>')
    : '';
  const note = viaApp
    ? `Reading with the app's Bearer Token, including your ${fmtInt(me?.following || 0)} following, which Sweep reads to see whom you follow back. If the app belongs to another X account, X bills $0.010 per account instead.`
    : `If your developer app belongs to a different X account, X bills these as ordinary user reads: about ${fmtUsd(n * OTHER_READ)}.`;
  return `${head}<h1>Scan your ${fmtInt(n)} followers</h1>
    <p class="lede">Sweep reads each follower's public profile once: checkmark, follower count, posts, the date of their last post, and whether you follow them back.</p>
    <div class="costs">
      <div><b>${fmtInt(reads)}</b><span>${viaApp ? 'reads' : 'owned reads'}</span></div>
      <div><b>about ${fmtUsd(reads * readPrice())}</b><span>at $0.001 per account</span></div>
      <div><b>$0</b><span>to scan again the same UTC day</span></div>
    </div>
    ${problem}${cheaper}
    <div class="cta">${start}</div>
    <p class="fine scopes">${note}</p>`;
}

function summaryHtml() {
  const c = D.counts;
  let info = '';
  if (S.demo) info = '<span>Sample data, nothing was read from X.</span>';
  else if (S.fmeta) {
    const sameDay = new Date(S.fmeta.scannedAt).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
    const price = sameDay ? 'free again today (same UTC day)' : `about ${fmtUsd((S.me?.followers || c.total) * readPrice())}`;
    info = `<span>Scanned ${ago(Date.now() - S.fmeta.scannedAt)}. A re-scan confirms removals: ${price}.</span>`;
    info += S.mode ? '<button class="btn sm" data-act="rescan">Re-scan</button>' : '<button class="btn sm" data-act="connect">Sign in to re-scan</button>';
  }
  const stat = (cls, n, label) => `<div class="stat ${cls}"><span class="n">${fmtInt(n)}</span><span class="l">${label}</span></div>`;
  return stat('', c.total, 'followers scanned') + stat('keep', c.keep, 'keep') + stat('rem', c.remove, 'to remove') + stat('done', S.removed.size, 'removed') + `<div class="scaninfo">${info}</div>`;
}

function rulesHtml() {
  const r = S.rules;
  const box = (key) => `<input type="checkbox" data-rule="${key}"${r[key] ? ' checked' : ''}>`;
  return `<h2>Keep rules</h2>
  <label class="rule">${box('keepVerified')}<span class="rt">Keep accounts with a checkmark<small>Blue is X Premium, gold a business, grey a government.</small></span><span class="rc" data-count="verified"></span></label>
  <div class="kinds" data-kinds></div>
  <label class="rule">${box('minOn')}<span class="rt">Keep accounts with at least <input class="num-in" type="number" min="1" step="100" data-rule="minFollowers" value="${r.minFollowers}" aria-label="Minimum followers"> followers</span><span class="rc" data-count="followers"></span></label>
  <label class="rule">${box('keepFollowing')}<span class="rt">Keep people you follow<small>So friends without Premium stay.</small></span><span class="rc" data-count="following"></span></label>
  <label class="rule">${box('keepSubscribers')}<span class="rt">Keep people who subscribe to you</span><span class="rc" data-count="subscriber"></span></label>
  <label class="rule">${box('inactiveOn')}<span class="rt">Only remove accounts silent for <input class="num-in" type="number" min="1" max="3650" data-rule="inactiveDays" value="${r.inactiveDays}" aria-label="Days without a post"> days<small>The number is how many have not posted for that long. Turn on to remove only them.</small></span><span class="rc" data-count="active"></span></label>
  <div class="manual"><span>Kept by you</span><b data-count="manual"></b></div>
  <div class="total"><span>To remove</span><b data-count="remove"></b></div>
  <p class="fine">The API can't see a checkmark someone chose to hide, or Premium Basic, which has no checkmark. Sweep treats those accounts as having none.</p>`;
}

function updateCounts() {
  const { reasons: rs, kinds, remove } = D.counts;
  const r = S.rules;
  const put = (key, on, n) => {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (el) el.textContent = on ? fmtInt(n || 0) : 'off';
  };
  put('verified', r.keepVerified, rs.verified);
  put('followers', r.minOn, rs.followers);
  put('following', r.keepFollowing, rs.following);
  put('subscriber', r.keepSubscribers, rs.subscriber);
  put('active', true, D.counts.silent);
  put('manual', true, rs.manual);
  put('remove', true, remove);
  patch(document.querySelector('[data-kinds]'), r.keepVerified
    ? ['blue', 'business', 'government'].map((k) => `<span>${CHECK(k)}${fmtInt(kinds[k] || 0)}</span>`).join('')
    : '');
}

const METHODS = { page: 'On your Followers page', queue: 'One by one', api: 'Automatic (API)' };
const mtabsHtml = () => Object.entries(METHODS).map(([k, label]) => `<button role="tab" aria-selected="${S.cfg.method === k}" data-act="method" data-method="${k}">${label}</button>`).join('');

function mbodyHtml() {
  const off = S.demo ? ' disabled' : '';
  const demoNote = S.demo ? '<p class="fine">Sample mode: these buttons are off because the sample accounts don\'t exist on X.</p>' : '';
  const left = D.remove.length;
  if (S.cfg.method === 'page') {
    return `<p>Open your Followers list on X and Sweep colours every row: <span class="pill rem">Remove</span> or <span class="pill keep">Keep</span>. On a red row click <b>⋯</b>, then <b>Remove this follower</b>, then <b>Remove</b>. The person isn't notified.</p>
      <div class="actions"><button class="btn primary" data-act="open-followers"${off}>Open my Followers on X</button>
        <label class="check"><input type="checkbox" data-cfg="dimKeepers"${S.cfg.dimKeepers ? ' checked' : ''}> Fade the rows Sweep keeps</label></div>
      <p class="fine">X doesn't tell Sweep when you remove someone there, so the numbers here change after a re-scan.</p>${demoNote}`;
  }
  if (S.cfg.method === 'queue') {
    const q = queueOrder();
    const first = q[0];
    const next = q.length > 1 ? `<div class="upnext">Then ${q.slice(1, 7).map((u) => `<span>@${esc(u.username)}</span>`).join('')}${q.length > 7 ? ` and ${fmtInt(q.length - 7)} more` : ''}</div>` : '';
    return `<p>Sweep opens one profile at a time, deadest first, with a bar at the bottom that says why. Remove each one on X with <b>⋯</b>, <b>Remove this follower</b>, <b>Remove</b>. When the "Follows you" label goes away Sweep marks it done; press <b>Next</b> on the bar to go on.</p>
      <div class="actions">${first
        ? `<button class="btn primary" data-act="queue-start"${off}>Start with @${esc(first.username)}</button><span class="muted">${fmtInt(left)} to go, about ${fmtDuration(left * HAND_SECONDS * 1000)} at ${HAND_SECONDS} s each</span>`
        : '<span class="muted">Nobody left to remove.</span>'}</div>${next}${demoNote}`;
  }
  const eligible = D.remove.filter((u) => u.youFollow === false).length;
  const unknown = D.remove.filter((u) => u.youFollow === null).length;
  const running = remover.status.running;
  const button = running
    ? '<button class="btn" data-act="api-stop">Stop</button>'
    : S.mode === 'app'
      ? '<span class="fine">Needs <b>Sign in with X</b>; the app\'s Bearer Token can\'t block.</span>'
      : blockScope()
      ? `<button class="btn danger" data-act="api-start"${off || (eligible ? '' : ' disabled')}>Remove up to ${fmtInt(Math.min(eligible, S.cfg.dailyCap))} now</button>`
      : `<button class="btn" data-act="grant-block"${off}>Allow blocking</button><span class="fine">Opens X to add the block permission to your sign-in.</span>`;
  return `<p>X's API has no "remove follower" call. What it can do is a soft block: block, then unblock right away, which ends their follow and leaves no block behind. X's docs list blocking as <b>Enterprise-only</b>, so a pay-per-use app will most likely be refused. Sweep stops at the first refusal, and nobody gets blocked.</p>
    <ul class="fine">
      <li>Never runs on people you follow, because a block would unfollow them too${unknown ? `; ${plural(unknown, 'account')} skipped because X didn't say whether you follow them` : ''}.</li>
      <li>One account every <input class="num-in" type="number" min="61" max="3600" data-cfg="intervalSec" value="${S.cfg.intervalSec}" aria-label="Seconds between removals"> seconds (X allows 15 blocks per 15 minutes), at most <input class="num-in" type="number" min="1" max="2000" data-cfg="dailyCap" value="${S.cfg.dailyCap}" aria-label="Daily cap"> a day.</li>
      <li>Keep this tab open while it runs. On pay-per-use each block and each unblock costs $0.001.</li>
    </ul>
    <div class="actions">${button}</div>
    <div class="status" id="api-status"></div>${demoNote}`;
}

function apiStatusHtml() {
  const st = remover.status;
  if (st.running) {
    const secs = st.waitUntil ? ` · next in ${Math.max(0, Math.ceil((st.waitUntil - Date.now()) / 1000))} s` : '';
    const who = st.current ? ` · now @${esc(st.current)}` : '';
    return notice('', `<b>${fmtInt(st.done)} of ${fmtInt(st.total)}</b> removed${who}${secs}${st.message ? ` · ${esc(st.message)}` : ''}`);
  }
  if (st.refused) return notice('err', esc(st.refused));
  if (st.error) return notice('err', esc(st.error));
  if (st.phase === 'capped') return notice('warn', `Today's limit of ${fmtInt(S.cfg.dailyCap)} is used up. Run it again tomorrow.`);
  if (st.phase === 'done' || st.phase === 'stopped') return notice('ok', `${plural(st.done, 'follower')} removed through the API${st.phase === 'stopped' ? ' before you stopped it' : ''}.`);
  return '';
}

function tabsHtml() {
  const t = (k, label, n) => `<button role="tab" aria-selected="${S.view === k}" data-act="view" data-view="${k}">${label}<span class="cnt">${fmtInt(n)}</span></button>`;
  return t('remove', 'To remove', D.remove.length) + t('keep', 'Keeping', D.keep.length) + t('done', 'Removed', S.removed.size);
}

let listCache = null;
function listItems() {
  const q = S.q.trim().toLowerCase();
  const key = `${D.version}|${S.view}|${q}|${S.sort}`;
  if (listCache?.key === key) return listCache.items;
  let items;
  if (S.view === 'done') {
    items = [...S.removed.entries()].filter(([id, r]) => !q || (S.byId.get(id)?.username || r.u || '').toLowerCase().includes(q)).sort((a, b) => b[1].at - a[1].at);
  } else {
    const base = S.view === 'remove' ? D.remove : D.keep;
    const hit = (u) => u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q) || u.bio.toLowerCase().includes(q);
    items = (q ? base.filter(hit) : base.slice()).sort(SORTS[S.sort].cmp);
  }
  listCache = { key, items };
  return items;
}

function listHtml() {
  const items = listItems();
  if (!items.length) {
    const why = S.q ? `No match for “${esc(S.q)}”.` : { remove: 'Nobody to remove with these rules.', keep: 'Nobody is kept with these rules.', done: 'Nothing removed yet. Followers you remove with Sweep show up here.' }[S.view];
    return `<div class="empty">${why}</div>`;
  }
  const rows = items.slice(0, S.limit).map(S.view === 'done' ? doneRow : userRow).join('');
  const rest = items.length - S.limit;
  return rows + (rest > 0 ? `<div class="more"><button class="btn" data-act="more">Show ${fmtInt(Math.min(PAGE, rest))} more (${fmtInt(rest)} left)</button></div>` : '');
}

function userRow(u) {
  const c = D.cls.get(u.id);
  const kind = checkKind(u);
  const lp = lastPostAt(u);
  const last = u.posts === 0 ? 'never' : lp == null ? 'hidden' : ago(Date.now() - lp);
  const chips = u._sig.filter((s) => s.key !== 'tiny').slice(0, 4);
  const why = S.view === 'remove'
    ? (chips.length ? chips.map((s) => `<span class="chip">${esc(s.label)}</span>`).join('') : `<span class="chip">${esc(reasonText(c, u, S.rules))}</span>`)
    : `<span class="pill keep">${esc(reasonText(c, u, S.rules))}</span>`;
  const btn = S.view === 'remove'
    ? `<button class="btn sm" data-act="keep" data-id="${esc(u.id)}">Keep</button>`
    : c.reason === 'manual' ? `<button class="btn sm" data-act="keep" data-id="${esc(u.id)}">Unkeep</button>` : '';
  return `<div class="u">${avatar(u.avatar, '', u.username)}
    <div class="who"><div class="nm">${profile(u.username, esc(u.name || u.username))}${kind ? CHECK(kind) : ''}${u.protected ? LOCK : ''}</div>
      <div class="hd">@${esc(u.username)}${u.bio ? ` · ${esc(u.bio)}` : ''}</div><div class="why">${why}</div></div>
    <div class="num keepme"><b>${fmtCompact(u.followers)}</b><span>followers</span></div>
    <div class="num"><b>${fmtCompact(u.posts)}</b><span>posts</span></div>
    <div class="num"><b>${esc(last)}</b><span>last post</span></div>
    <div class="act">${btn}</div></div>`;
}

function doneRow([id, r]) {
  const u = S.byId.get(id);
  const username = u?.username || r.u || '';
  const name = u?.name || r.n || username || id;
  const how = { api: 'soft block through the API', detected: 'seen on X', manual: 'marked by you' }[r.via] || 'marked';
  const state = r.confirmed ? '<span class="chip ok">confirmed by re-scan</span>' : '<span class="chip">re-scan to confirm</span>';
  return `<div class="u">${avatar(u?.avatar || r.a, '', username)}
    <div class="who"><div class="nm">${username ? profile(username, esc(name)) : esc(name)}</div>
      <div class="hd">@${esc(username)} · removed ${ago(Date.now() - r.at)}, ${how}</div><div class="why">${state}</div></div>
    <div class="num keepme"></div><div class="num"></div><div class="num"></div>
    <div class="act">${r.confirmed ? '' : `<button class="btn sm" data-act="unmark" data-id="${esc(id)}">Undo</button>`}</div></div>`;
}

function footHtml(sc) {
  const links = [];
  if (S.auth && !S.demo) links.push('<button class="linkbtn" data-act="disconnect">Disconnect X</button>');
  if (S.app?.bearer && !S.demo) links.push('<button class="linkbtn" data-act="forget-bearer">Forget Bearer Token</button>');
  if (S.app?.clientId && sc !== 'setup' && !S.demo) links.push('<button class="linkbtn" data-act="edit-app">Change Client ID</button>');
  links.push('<button class="linkbtn" data-act="wipe">Delete all Sweep data</button>');
  links.push('<a href="https://github.com/winchxyz/follower-sweep" target="_blank" rel="noopener noreferrer">★ Star on GitHub</a>');
  links.push('<a href="https://x.com/winchxyz" target="_blank" rel="noopener noreferrer">Follow @winchxyz</a>');
  return `<p>Sweep only uses the official X API, through your own developer app. It never clicks, posts, follows or unfollows for you, and what it reads stays in this browser.</p><div class="links">${links.join('')}</div>`;
}

// ---------- actions ----------

let toastTimer = 0;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
const flash = (kind, html) => (S.flash = { kind, html });
const openTab = (url) => chrome.tabs.create({ url });

async function doConnect(withBlocks) {
  S.busy = 'connect';
  schedule();
  try {
    const me = await x.connect({ withBlocks });
    if (S.fmeta && S.fmeta.userId !== me.id) await wipeData(['app', 'dev', 'auth', 'me', 'cfg', 'rules']);
    S.flash = null;
    await loadAll();
    toast(`Signed in as @${me.username}`);
  } catch (e) {
    let hint = '';
    if (['authorize', 'token'].includes(e.step)) {
      hint = ` If X showed an error page, check that the app's callback URI is exactly <code>${esc(REDIRECT)}</code> and its type is Native App, or paste the Client Secret for a Web App.`;
    } else if (e.step === 'profile' && e.status === 401) {
      hint = ' <br><b>The sign-in itself worked; X then refused its own token.</b> New pay-per-use apps often do this until X enables them for user sign-in, which only X can do. Check that your developer account has credits and the app sits in a pay-per-use project, then sign in again. If it still fails, post your App ID on the <a href="https://devcommunity.x.com/c/x-api/x-api-v2/" target="_blank" rel="noopener noreferrer">X developer forum</a> and ask X to fix the app\'s user-context enrollment. Meanwhile you can scan with your app\'s Bearer Token (below).';
    }
    flash('err', esc(explainError(e)) + hint);
  } finally {
    S.busy = '';
  }
}

async function doScan(fresh) {
  if (scanner.status.running) return;
  const run = scanner.run({ fresh });
  schedule();
  await run;
  await loadAll();
  if (scanner.status.phase === 'done') {
    S.view = 'remove';
    S.limit = PAGE;
    toast(`Scan done: ${fmtInt(S.users.length)} followers`);
  }
}

async function startSample() {
  await wipeData(['app', 'dev']);
  const now = Date.now();
  const users = sampleFollowers({ count: 1250, seed: 7, now }).map(slimUser);
  await store.setMany({ demo: true, me: { ...SAMPLE_ME, avatar: '', followers: users.length, following: 318, verifiedType: null, at: now } });
  await saveFollowers(store, users, { userId: SAMPLE_ME.id, username: SAMPLE_ME.username, scannedAt: now - 2 * 3_600_000, startedAt: now - 2 * 3_600_000, fields: [], mutualSource: 'sample' });
  const quiet = users.filter((u) => u.posts === 0 && !u.verified && u.followers < 50);
  const marks = {};
  quiet.slice(0, 4).forEach((u, i) => (marks[`rm:${u.id}`] = { at: now - (i + 1) * 3_600_000, via: i % 2 ? 'detected' : 'manual', u: u.username, n: u.name, a: u.avatar, ...(i < 2 ? { confirmed: now - 1_800_000 } : {}) }));
  const friendly = users.filter((u) => !u.verified && u.followers < 500 && u.posts > 100 && !u.youFollow);
  friendly.slice(0, 2).forEach((u) => (marks[`keep:${u.id}`] = { at: now, u: u.username }));
  await store.setMany(marks);
  S.editingApp = false;
  S.flash = null;
  await loadAll();
}

const ACT = {
  async copy(el) {
    await navigator.clipboard.writeText(el.dataset.text);
    toast('Copied');
  },
  sample: startSample,
  async 'leave-sample'() {
    await wipeData(['app', 'dev']);
    S.view = 'remove';
    await loadAll();
  },
  'edit-app'() {
    S.editingApp = true;
  },
  'cancel-edit'() {
    S.editingApp = false;
  },
  connect: () => doConnect(false),
  'grant-block': () => doConnect(true),
  scan: () => doScan(false),
  'scan-fresh': () => doScan(true),
  rescan: () => doScan(true),
  'pause-scan'() {
    scanner.stop();
  },
  async keep(el) {
    const id = el.dataset.id;
    if (S.keep.has(id)) await store.remove(`keep:${id}`);
    else await store.set(`keep:${id}`, { at: Date.now(), u: S.byId.get(id)?.username || '' });
    await loadMarks();
  },
  async unmark(el) {
    await store.remove(`rm:${el.dataset.id}`);
    await loadMarks();
  },
  view(el) {
    S.view = el.dataset.view;
    S.limit = PAGE;
  },
  async method(el) {
    S.cfg.method = el.dataset.method;
    await saveCfg();
  },
  more() {
    S.limit += PAGE;
  },
  'open-followers'() {
    openTab(`https://x.com/${encodeURIComponent(S.me.username)}/followers`);
  },
  'queue-start'() {
    const first = queueOrder()[0];
    if (first) openTab(`https://x.com/${encodeURIComponent(first.username)}`);
  },
  'api-start'() {
    const list = queueOrder();
    const n = Math.min(list.filter((u) => u.youFollow === false).length, S.cfg.dailyCap);
    const ok = confirm(`Soft-block up to ${n} followers through the X API?\n\nEach one is blocked and unblocked right away, which removes them as a follower. If X refuses, which is likely on pay-per-use, Sweep stops and nobody is blocked.`);
    if (ok) remover.run(list, S.cfg);
  },
  'api-stop'() {
    remover.stop();
  },
  'api-release'() {
    remover.release();
  },
  export: exportCsv,
  async disconnect() {
    if (!confirm('Sign out of X? Sweep revokes its token. Your scan and marks stay here.')) return;
    await x.revoke();
    await loadAll();
  },
  async 'forget-bearer'() {
    if (!confirm('Remove the Bearer Token from Sweep? Your scan and marks stay here.')) return;
    const { bearer, ...rest } = S.app || {};
    await store.set('app', rest);
    await loadAll();
  },
  async wipe() {
    if (!confirm('Delete everything Sweep stored: the follower list, your marks and keep list, the sign-in and any Bearer Token? The Client ID stays.')) return;
    if (S.auth) await x.revoke();
    await wipeData(['app', 'dev']);
    const { bearer, ...rest } = S.app || {};
    if (bearer) await store.set('app', rest);
    S.view = 'remove';
    S.flash = null;
    await loadAll();
    toast('Deleted');
  },
  dismiss() {
    S.flash = null;
  },
  async 'seen-reconcile'() {
    S.cfg.reconcileSeen = S.reconcile?.at || 0;
    await saveCfg();
  },
};

function exportCsv() {
  const head = ['username', 'name', 'verdict', 'reason', 'followers', 'following', 'posts', 'checkmark', 'last_post', 'you_follow', 'id', 'profile'];
  const rows = S.users.map((u) => {
    const c = D.cls.get(u.id);
    const lp = lastPostAt(u);
    return [
      u.username, u.name, S.removed.has(u.id) ? 'removed' : c.action, reasonText(c, u, S.rules),
      u.followers, u.following, u.posts, checkKind(u) || '', lp ? new Date(lp).toISOString().slice(0, 10) : '',
      u.youFollow == null ? '' : u.youFollow ? 'yes' : 'no', u.id, `https://x.com/${u.username}`,
    ];
  });
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from running names as formulas
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `sweep-${S.me?.username || 'followers'}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  try {
    await fn(el);
  } catch (err) {
    flash('err', esc(explainError(err)));
  }
  schedule();
});

let qTimer = 0;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    S.q = e.target.value;
    S.limit = PAGE;
    schedule();
  }, 120);
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.rule) {
    const key = el.dataset.rule;
    S.rules = normalizeRules({ ...S.rules, [key]: el.type === 'checkbox' ? el.checked : Number(el.value) });
    if (el.type !== 'checkbox') el.value = S.rules[key];
    await store.set('rules', S.rules);
    derive();
  } else if (el.dataset.cfg) {
    const key = el.dataset.cfg;
    let v = el.type === 'checkbox' ? el.checked : Number(el.value);
    if (key === 'intervalSec') v = clampInt(v, 61, 3600, API_DEFAULTS.intervalSec);
    if (key === 'dailyCap') v = clampInt(v, 1, 2000, API_DEFAULTS.dailyCap);
    if (el.type !== 'checkbox') el.value = v;
    S.cfg[key] = v;
    await saveCfg();
  } else if (el.id === 'sort') {
    S.sort = el.value;
    S.limit = PAGE;
  }
  schedule();
});

// The app's Bearer Token: check it right away by looking up the handle.
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form="bearer"]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const handle = String(fd.get('handle') || '').trim().replace(/^@/, '');
  const bearer = String(fd.get('bearer') || '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    flash('err', 'Type your X handle, like @winchxyz.');
    return schedule();
  }
  if (bearer.length < 30 || /\s/.test(bearer)) {
    flash('err', 'That doesn\'t look like a Bearer Token. Copy it from the app\'s Keys and tokens page.');
    return schedule();
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Checking…';
  const before = (await store.get('app')) || {};
  await store.set('app', { ...before, bearer, handle });
  try {
    const me = await x.me();
    if (S.fmeta && S.fmeta.userId !== me.id) await wipeData(['app', 'dev', 'me', 'cfg', 'rules']);
    S.flash = null;
    toast(`Reading as @${me.username} with the app token`);
  } catch (err) {
    const { bearer: _, ...rest } = before;
    await store.set('app', rest);
    flash('err', `${esc(explainError(err))} Check that you copied the whole Bearer Token and typed your handle.`);
    button.disabled = false;
    button.textContent = 'Use token';
  }
  await loadAll();
  schedule();
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form="app"]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const clientId = String(fd.get('clientId') || '').trim();
  const clientSecret = String(fd.get('clientSecret') || '').trim();
  if (!/^[A-Za-z0-9_\-:.]{8,}$/.test(clientId)) {
    flash('err', 'That doesn\'t look like a Client ID. Copy the OAuth 2.0 Client ID from the app\'s Keys and tokens page.');
    schedule();
    return;
  }
  const changed = clientId !== S.app?.clientId || clientSecret !== (S.app?.clientSecret || '');
  if (changed && S.auth) await x.revoke(); // tokens belong to the old app
  const { clientSecret: _, ...rest } = S.app || {}; // keep a saved Bearer Token and handle
  await store.set('app', clientSecret ? { ...rest, clientId, clientSecret } : { ...rest, clientId });
  S.editingApp = false;
  S.flash = null;
  await loadAll();
  schedule();
});

(async () => {
  render();
  await loadAll();
  render();
})();
