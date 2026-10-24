// Reads your followers with GET /2/users/:id/followers, 1,000 per page. Every
// page is saved as it arrives, so closing the tab, a rate limit or an empty
// credit balance only pauses the scan. Reading your own followers with your own
// app bills as "owned reads" ($0.001 each, repeats on the same UTC day free).
import { sleep } from './util.js';
import { XError, explainError, mentionsField, acceptedFields } from './xapi.js';
import { withPrefix } from './store.js';

export const CORE_FIELDS = ['created_at', 'description', 'name', 'profile_image_url', 'protected', 'public_metrics', 'username', 'verified', 'verified_type'];
export const EXTRA_FIELDS = ['most_recent_tweet_id', 'connection_status', 'subscription'];
const CHUNK = 5000;
const RESUME_WINDOW = 20 * 3_600_000;

export function slimUser(u) {
  const m = u.public_metrics || {};
  const cs = Array.isArray(u.connection_status) ? u.connection_status : null;
  const avatar = typeof u.profile_image_url === 'string' ? u.profile_image_url : '';
  return {
    id: String(u.id),
    username: String(u.username || ''),
    name: String(u.name || ''),
    avatar,
    defaultAvatar: avatar.includes('default_profile_images'),
    verified: u.verified === true,
    verifiedType: ['blue', 'business', 'government'].includes(u.verified_type) ? u.verified_type : null,
    followers: Number(m.followers_count) || 0,
    following: Number(m.following_count) || 0,
    posts: Number(m.tweet_count) || 0,
    createdAt: u.created_at || null,
    lastPostId: u.most_recent_tweet_id || null,
    protected: u.protected === true,
    bio: String(u.description || '').slice(0, 240),
    youFollow: cs ? cs.includes('following') : null,
    subscribesToYou: u.subscription && typeof u.subscription === 'object' ? u.subscription.subscribes_to_you === true : null,
  };
}

export async function loadFollowers(store) {
  const meta = await store.get('fmeta');
  if (!meta) return [];
  const keys = Array.from({ length: meta.chunks }, (_, i) => `f:${i}`);
  const got = await store.getMany(keys);
  return keys.flatMap((k) => got[k] || []);
}

// Replaces the stored follower list (chunked) and drops leftovers of a scan.
export async function saveFollowers(store, users, meta) {
  const chunks = Math.ceil(users.length / CHUNK);
  const batch = { fmeta: { ...meta, count: users.length, chunks } };
  for (let c = 0; c < chunks; c++) batch[`f:${c}`] = users.slice(c * CHUNK, (c + 1) * CHUNK);
  await store.setMany(batch);
  const stale = (await store.keys()).filter((k) => (k.startsWith('f:') && Number(k.slice(2)) >= chunks) || k.startsWith('sp:') || k === 'scan');
  if (stale.length) await store.remove(stale);
}

class Stopped extends Error {}

export function createScanner({ x, store, onUpdate = () => {}, now = () => Date.now() }) {
  const status = { running: false, phase: 'idle', found: 0, expected: 0, pages: 0, reads: 0, waitUntil: 0, message: '', error: null, finishedAt: 0 };
  let ctrl = null;
  const set = (patch) => {
    Object.assign(status, patch);
    onUpdate(status);
  };

  async function waitUntil(ts, why) {
    set({ waitUntil: ts, message: why });
    while (!ctrl.signal.aborted && now() < ts) await sleep(Math.min(1000, ts - now()), ctrl.signal);
    set({ waitUntil: 0, message: '' });
    if (ctrl.signal.aborted) throw new Stopped();
  }

  // One GET with the retry policy: wait out 429s, back off on network and 5xx
  // errors, and drop user fields that X says this endpoint does not accept.
  async function get(path, query, st) {
    let failures = 0;
    for (let fixes = 0; ; ) {
      if (ctrl.signal.aborted) throw new Stopped();
      const q = st ? { ...query, 'user.fields': st.fields.join(',') } : query;
      try {
        return await x.call('GET', path, { query: q });
      } catch (e) {
        if (!(e instanceof XError)) throw e;
        if (e.status === 429) {
          await waitUntil(Math.max(e.retryAt, now()) + 1000, 'X rate limit: waiting for the window to reset');
          continue;
        }
        if (st && fixes < 2 && mentionsField(e, 'user.fields')) {
          const next = acceptedFields(e, st.fields) || (st.fields.length > CORE_FIELDS.length ? CORE_FIELDS.slice() : null);
          if (next) {
            st.fields = next;
            fixes++;
            continue;
          }
        }
        if (e.retryable && failures < 6) {
          failures++;
          await waitUntil(now() + Math.min(60_000, 2000 * 2 ** failures), e.status ? `X error ${e.status}, retrying` : 'Network error, retrying');
          continue;
        }
        throw e;
      }
    }
  }

  async function pageThrough(path, st, onPage) {
    let next = st?.next ?? null;
    do {
      const r = await get(path, { max_results: 1000, pagination_token: next || undefined }, st);
      next = r.json?.meta?.next_token || null;
      await onPage(r.json?.data || [], next);
      if (next && r.rate.remaining === 0 && r.rate.reset) await waitUntil(r.rate.reset + 1000, 'X rate limit: waiting for the window to reset');
    } while (next);
  }

  async function run({ fresh = false } = {}) {
    if (status.running) return;
    ctrl = new AbortController();
    const startedAt = now();
    set({ running: true, phase: 'profile', error: null, message: 'Reading your profile', found: 0, pages: 0, reads: 0, waitUntil: 0 });
    try {
      const me = await x.me();
      set({ expected: me.followers, reads: 1 });

      let st = fresh ? null : await store.get('scan');
      if (st && (st.userId !== me.id || now() - st.updatedAt > RESUME_WINDOW)) st = null;
      if (!st) {
        const old = (await store.keys()).filter((k) => k.startsWith('sp:'));
        if (old.length) await store.remove(old);
        // connection_status and subscription describe them relative to you, so they need your sign-in.
        const fields = (await x.mode()) === 'app' ? [...CORE_FIELDS, 'most_recent_tweet_id'] : [...CORE_FIELDS, ...EXTRA_FIELDS];
        st = { userId: me.id, next: null, fields, pages: 0, count: 0, startedAt, updatedAt: startedAt };
      }
      set({ phase: 'followers', found: st.count, pages: st.pages, message: '' });

      await pageThrough(`/2/users/${me.id}/followers`, st, async (data, next) => {
        await store.set(`sp:${st.pages}`, data.map(slimUser));
        Object.assign(st, { pages: st.pages + 1, count: st.count + data.length, next, updatedAt: now() });
        await store.set('scan', st);
        set({ found: st.count, pages: st.pages, reads: status.reads + data.length });
      });

      const pages = await store.getMany(Array.from({ length: st.pages }, (_, i) => `sp:${i}`));
      const seen = new Set();
      const users = [];
      for (let i = 0; i < st.pages; i++) {
        for (const u of pages[`sp:${i}`] || []) {
          if (seen.has(u.id)) continue;
          seen.add(u.id);
          users.push(u);
        }
      }

      // connection_status tells us whom you follow. If X left it out, read your
      // following list instead (also owned reads).
      let mutualSource = 'connection_status';
      if (users.length && users.every((u) => u.youFollow === null)) {
        set({ phase: 'following', message: 'Checking which followers you follow back' });
        const ids = new Set();
        await pageThrough(`/2/users/${me.id}/following`, null, async (data) => {
          for (const u of data) ids.add(String(u.id));
          set({ reads: status.reads + data.length });
        });
        for (const u of users) u.youFollow = ids.has(u.id);
        mutualSource = 'following';
      }

      const before = await loadFollowers(store);
      await saveFollowers(store, users, { userId: me.id, username: me.username, scannedAt: now(), startedAt: st.startedAt, fields: st.fields, mutualSource });
      await reconcile(store, users, before, st.startedAt, now());
      set({ phase: 'done', finishedAt: now(), message: '' });
    } catch (e) {
      if (e instanceof Stopped) set({ phase: 'paused', message: 'Paused. Scan again to continue from the last page.' });
      else set({ phase: 'error', error: explainError(e), message: '' });
    } finally {
      set({ running: false, waitUntil: 0 });
    }
  }

  // The accounts you follow, with the same profile fields, so Sweep can show who
  // doesn't follow you back and who looks dead. About 4 pages for most accounts,
  // so it keeps the pages in memory instead of saving each one.
  async function runFollowing() {
    if (status.running) return;
    ctrl = new AbortController();
    const startedAt = now();
    set({ running: true, phase: 'profile', error: null, message: 'Reading your profile', found: 0, pages: 0, reads: 0, waitUntil: 0 });
    try {
      const me = await x.me();
      set({ phase: 'following-list', expected: me.following, reads: 1, message: '' });
      const st = { next: null, fields: [...CORE_FIELDS, 'most_recent_tweet_id'] };
      const seen = new Set();
      const users = [];
      await pageThrough(`/2/users/${me.id}/following`, st, async (data) => {
        for (const raw of data) {
          const u = slimUser(raw);
          if (seen.has(u.id)) continue;
          seen.add(u.id);
          users.push(u);
        }
        set({ found: users.length, pages: status.pages + 1, reads: status.reads + data.length });
      });
      const followerIds = new Set((await loadFollowers(store)).map((u) => u.id));
      for (const u of users) {
        u.youFollow = true;
        u.followsYou = followerIds.size ? followerIds.has(u.id) : null;
      }
      await saveList(store, 'g', 'gmeta', users, { userId: me.id, scannedAt: now(), startedAt, followersKnown: followerIds.size > 0 });
      await reconcileUnfollows(store, users, startedAt, now());
      set({ phase: 'done', finishedAt: now(), message: '' });
    } catch (e) {
      if (e instanceof Stopped) set({ phase: 'paused', message: 'Paused. Scan your following again to start over.' });
      else set({ phase: 'error', error: explainError(e), message: '' });
    } finally {
      set({ running: false, waitUntil: 0 });
    }
  }

  return { status, run, runFollowing, stop: () => ctrl?.abort() };
}

export async function loadList(store, prefix, metaKey) {
  const meta = await store.get(metaKey);
  if (!meta) return [];
  const keys = Array.from({ length: meta.chunks }, (_, i) => `${prefix}:${i}`);
  const got = await store.getMany(keys);
  return keys.flatMap((k) => got[k] || []);
}

export async function saveList(store, prefix, metaKey, users, meta) {
  const chunks = Math.ceil(users.length / CHUNK);
  const batch = { [metaKey]: { ...meta, count: users.length, chunks } };
  for (let c = 0; c < chunks; c++) batch[`${prefix}:${c}`] = users.slice(c * CHUNK, (c + 1) * CHUNK);
  await store.setMany(batch);
  const stale = (await store.keys()).filter((k) => k.startsWith(`${prefix}:`) && Number(k.slice(prefix.length + 1)) >= chunks);
  if (stale.length) await store.remove(stale);
}

// Unfollow marks (uf:<id>): gone from the new list means confirmed; still there means it didn't happen.
export async function reconcileUnfollows(store, users, startedAt, at = Date.now()) {
  const ids = new Set(users.map((u) => u.id));
  const marks = await withPrefix(store, 'uf:');
  const updates = {};
  const drop = [];
  for (const [id, r] of marks) {
    if (r.at >= startedAt) continue;
    if (ids.has(id)) drop.push(`uf:${id}`);
    else if (!r.confirmed) updates[`uf:${id}`] = { ...r, confirmed: at };
  }
  if (drop.length) await store.remove(drop);
  if (Object.keys(updates).length) await store.setMany(updates);
}

// After a scan: accounts you marked as removed that are gone are confirmed;
// ones still following go back to the list. Marks made during the scan are
// skipped, since the scan may have read them before you removed them.
export async function reconcile(store, users, before, startedAt, at = Date.now()) {
  const ids = new Set(users.map((u) => u.id));
  const old = new Map(before.map((u) => [u.id, u]));
  const marks = await withPrefix(store, 'rm:');
  const updates = {};
  const back = [];
  const backKeys = [];
  let confirmed = 0;
  for (const [id, r] of marks) {
    if (r.at >= startedAt) continue;
    if (ids.has(id)) {
      back.push(r.u);
      backKeys.push(`rm:${id}`);
      continue;
    }
    if (!r.confirmed) {
      const u = old.get(id);
      updates[`rm:${id}`] = { ...r, confirmed: at, n: r.n || u?.name || '', a: r.a || u?.avatar || '' };
      confirmed++;
    }
  }
  if (backKeys.length) await store.remove(backKeys);
  updates.lastReconcile = { at, confirmed, back: back.length, names: back.slice(0, 12) };
  await store.setMany(updates);
  return updates.lastReconcile;
}
