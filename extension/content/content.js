// Sweep on x.com. Colours the rows of your Followers page and shows a bar on the
// profiles of your followers. It reads the page and Sweep's own storage and
// writes only to Sweep's storage. It never clicks, types or sends anything to
// X; you remove people with X's own menu.
(() => {
  'use strict';
  if (window.top !== window || window.__sweepLoaded) return;
  window.__sweepLoaded = true;

  const area = chrome.storage.local;
  const S = { me: '', map: null, queue: [], dim: true, path: null };
  let P = null; // the follower profile on screen: { handle, id, code, label, marked, kept }
  let observer = null;
  let watch = 0;
  let ui = null;
  let hidden = false;

  const LOGO = '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#f2f1ec"/><path d="M23.2 5.4 16 15.4" stroke="#151515" stroke-width="2.6" stroke-linecap="round"/><path d="M12.6 13.3 18.6 17.6 14.3 26.8 5.3 20.3Z" fill="#e4472a"/><path d="M14.4 16.1 10 22.7M16.6 17.7 12.5 24.7" stroke="#f2f1ec" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const CSS = `
    :host { all: initial; }
    .box { box-sizing: border-box; display: flex; align-items: center; gap: 12px; padding: 10px 10px 10px 12px;
      max-width: min(780px, calc(100vw - 24px)); background: #151515; color: #f2f1ec; border-radius: 14px;
      box-shadow: 0 10px 34px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.08);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .logo { width: 24px; height: 24px; flex: none; }
    .txt { min-width: 0; flex: 1 1 auto; }
    .line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hint { color: #b5b3ac; font-size: 12px; margin-top: 1px; }
    .tag { display: inline-block; font-weight: 800; font-size: 10.5px; letter-spacing: .08em; padding: 2px 7px; border-radius: 6px; margin-right: 6px; vertical-align: 1px; }
    .tag.r { background: #e4472a; color: #fff; }
    .tag.k { background: #1f8f5c; color: #fff; }
    .tag.d { background: #55544f; color: #fff; }
    b { font-weight: 700; }
    .btns { display: flex; gap: 6px; flex: none; align-items: center; }
    button { font: inherit; font-weight: 650; border: 1px solid #3b3b38; background: #242423; color: #f2f1ec; border-radius: 9px;
      padding: 6px 11px; cursor: pointer; white-space: nowrap; }
    button:hover { border-color: #8a8882; }
    button.go { background: #f2f1ec; color: #151515; border-color: #f2f1ec; }
    button.x { border: 0; background: none; color: #8f8d87; padding: 6px 7px; font-size: 16px; line-height: 1; }
    label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; white-space: nowrap; color: #d9d7d0; }
    input { accent-color: #f2f1ec; margin: 0; }
    @media (max-width: 700px) { .box { flex-wrap: wrap; } .btns { width: 100%; justify-content: flex-end; } }
  `;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  async function load() {
    const got = await area.get(['verdicts', 'queue', 'cfg']);
    S.me = got.verdicts?.me || '';
    S.map = got.verdicts?.map || null;
    S.queue = Array.isArray(got.queue) ? got.queue : [];
    S.dim = got.cfg?.dimKeepers !== false;
    document.documentElement.classList.toggle('sweep-dim', S.dim);
    S.path = null;
    route();
  }

  function route() {
    const path = location.pathname;
    if (path === S.path) return;
    S.path = path;
    teardown();
    if (!S.map || !S.me) return;
    const seg = path.split('/').filter(Boolean).map((s) => s.toLowerCase());
    if (seg.length === 2 && seg[0] === S.me && (seg[1] === 'followers' || seg[1] === 'verified_followers')) followersPage();
    else if (seg.length >= 1 && seg[0] !== S.me && S.map[seg[0]] && (seg.length === 1 || ['with_replies', 'media', 'highlights', 'articles'].includes(seg[1]))) profilePage(seg[0]);
  }

  function teardown() {
    observer?.disconnect();
    observer = null;
    clearInterval(watch);
    watch = 0;
    P = null;
    hidden = false;
    for (const el of document.querySelectorAll('[data-sweep]')) {
      delete el.dataset.sweep;
      delete el.dataset.sweepLabel;
    }
    ui?.host.remove();
    ui = null;
  }

  function mount(html) {
    if (hidden) return;
    if (!ui) {
      const host = document.createElement('div');
      host.id = 'sweep-ui';
      host.style.cssText = 'position:fixed;z-index:2147483000;left:50%;bottom:16px;transform:translateX(-50%);';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style><div class="box"></div>`;
      root.addEventListener('click', onClick);
      root.addEventListener('change', onChange);
      document.documentElement.append(host);
      ui = { host, box: root.querySelector('.box') };
    }
    ui.box.innerHTML = html;
  }

  // ---- Followers page: colour every row ----

  function followersPage() {
    annotate();
    let queued = false;
    const mo = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (observer === mo) annotate();
      });
    });
    observer = mo;
    mo.observe(document.body, { childList: true, subtree: true });
    let r = 0, k = 0;
    for (const v of Object.values(S.map)) {
      if (v[1] === 'r') r++;
      else if (v[1] === 'k') k++;
    }
    mount(`${LOGO}<div class="txt"><div class="line"><b>Sweep</b> · <span class="tag r">REMOVE</span>${r.toLocaleString('en-US')} <span class="tag k">KEEP</span>${k.toLocaleString('en-US')}</div>
      <div class="hint line">On a red row: ⋯ → Remove this follower → Remove. Re-scan in Sweep afterwards.</div></div>
      <div class="btns"><label><input type="checkbox" data-dim${S.dim ? ' checked' : ''}> Fade kept</label><button data-do="app">Open Sweep</button><button class="x" data-do="hide" title="Hide">×</button></div>`);
  }

  function cellHandle(cell) {
    for (const a of cell.querySelectorAll('a[href^="/"]')) {
      const m = /^\/([A-Za-z0-9_]{1,15})$/.exec(a.getAttribute('href'));
      if (m) return m[1].toLowerCase();
    }
    return '';
  }

  function annotate() {
    const column = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main') || document;
    for (const cell of column.querySelectorAll('[data-testid="UserCell"]')) {
      const handle = cellHandle(cell);
      const v = handle ? S.map[handle] : null;
      const state = !v ? 'unknown' : v[1] === 'r' ? 'remove' : v[1] === 'd' ? 'done' : 'keep';
      const label = v ? v[4] : 'Sweep: not in your last scan';
      if (cell.dataset.sweep !== state) cell.dataset.sweep = state;
      if (cell.dataset.sweepLabel !== label) cell.dataset.sweepLabel = label;
    }
  }

  // ---- A follower's profile: why, and what next ----

  async function profilePage(handle) {
    const v = S.map[handle];
    P = { handle, id: v[0], code: v[1], label: v[4], marked: null, kept: false };
    await refreshProfile();
    if (P?.code === 'r') watchFollowLabel(P);
  }

  async function refreshProfile() {
    if (!P) return;
    const p = P;
    const got = await area.get([`rm:${p.id}`, `keep:${p.id}`]);
    if (P !== p) return;
    p.marked = got[`rm:${p.id}`]?.via || null;
    p.kept = Boolean(got[`keep:${p.id}`]);
    const next = await nextAfter(p.handle);
    if (P !== p) return;
    p.next = next;
    const nextBtn = next ? `<button class="go" data-do="next">Next: @${esc(next)} →</button>` : '<button data-do="app">Open Sweep</button>';
    const detail = esc(p.label.replace(/^(Remove|Keep) · /, ''));
    let html;
    if (p.marked) {
      html = `<div class="txt"><div class="line"><span class="tag d">REMOVED</span><b>@${esc(p.handle)}</b> ${p.marked === 'detected' ? 'no longer follows you' : 'marked as removed'}</div>
        <div class="hint line">A re-scan in Sweep confirms it.</div></div><div class="btns"><button data-do="undo">Undo</button>${nextBtn}</div>`;
    } else if (p.kept || p.code === 'k') {
      html = `<div class="txt"><div class="line"><span class="tag k">KEEP</span><b>@${esc(p.handle)}</b> · ${p.kept ? 'kept by you' : detail}</div>
        <div class="hint line">Sweep keeps this follower.</div></div><div class="btns">${p.kept ? '<button data-do="unkeep">Don\'t keep</button>' : ''}${nextBtn}</div>`;
    } else {
      html = `<div class="txt"><div class="line"><span class="tag r">REMOVE</span><b>@${esc(p.handle)}</b> · ${detail}</div>
        <div class="hint line">Here: ⋯ → Remove this follower → Remove, then Next.</div></div>
        <div class="btns"><button data-do="mark">Mark removed</button><button data-do="keep">Keep</button>${next ? `<button data-do="next">Skip →</button>` : ''}</div>`;
    }
    mount(LOGO + html);
  }

  // The "Follows you" label in the profile header. Rows in "Who to follow" are skipped.
  function followLabel() {
    const column = document.querySelector('[data-testid="primaryColumn"]') || document;
    for (const el of column.querySelectorAll('[data-testid="userFollowIndicator"]')) {
      if (!el.closest('[data-testid="UserCell"]')) return el;
    }
    return null;
  }

  // Seen, then gone for 1.5 s: they no longer follow you. If it comes back, undo.
  function watchFollowLabel(p) {
    let seen = false;
    let goneAt = 0;
    watch = setInterval(async () => {
      if (P !== p) return;
      if (followLabel()) {
        seen = true;
        goneAt = 0;
        if (p.marked === 'detected') await area.remove(`rm:${p.id}`);
        return;
      }
      if (!seen || p.marked || p.kept) return;
      if (!goneAt) goneAt = Date.now();
      else if (Date.now() - goneAt > 1500) {
        p.marked = 'detected';
        await area.set({ [`rm:${p.id}`]: { at: Date.now(), via: 'detected', u: p.handle } });
      }
    }, 500);
  }

  async function nextAfter(handle) {
    const q = S.queue;
    for (let i = q.findIndex(([h]) => h === handle) + 1; i < q.length; i += 25) {
      const slice = q.slice(i, i + 25).filter(([h]) => h !== handle);
      const got = await area.get(slice.flatMap(([, id]) => [`rm:${id}`, `keep:${id}`]));
      const hit = slice.find(([, id]) => !got[`rm:${id}`] && !got[`keep:${id}`]);
      if (hit) return hit[0];
    }
    return null;
  }

  async function onClick(e) {
    const el = e.target.closest('[data-do]');
    if (!el) return;
    const p = P;
    switch (el.dataset.do) {
      case 'app':
        chrome.runtime.sendMessage({ type: 'open-app' });
        break;
      case 'hide':
        hidden = true;
        ui?.host.remove();
        ui = null;
        break;
      case 'next':
        if (p?.next) location.assign(`https://x.com/${encodeURIComponent(p.next)}`);
        break;
      case 'mark':
        if (p) await area.set({ [`rm:${p.id}`]: { at: Date.now(), via: 'manual', u: p.handle } });
        break;
      case 'undo':
        if (p) await area.remove(`rm:${p.id}`);
        break;
      case 'keep':
        if (p) await area.set({ [`keep:${p.id}`]: { at: Date.now(), u: p.handle } });
        break;
      case 'unkeep':
        if (p) await area.remove(`keep:${p.id}`);
        break;
    }
  }

  async function onChange(e) {
    if (!e.target.matches('[data-dim]')) return;
    const got = await area.get('cfg');
    await area.set({ cfg: { ...(got.cfg || {}), dimKeepers: e.target.checked } });
  }

  chrome.storage.onChanged.addListener((changes, name) => {
    if (name !== 'local') return;
    if (changes.verdicts || changes.queue || changes.cfg) return void load();
    if (P && (changes[`rm:${P.id}`] || changes[`keep:${P.id}`])) refreshProfile();
  });

  setInterval(route, 400);
  load();
})();
