// Automatic removal through the official API, for apps X allows to block.
// X has no "remove follower" endpoint. The API way is a soft block: block, then
// unblock at once, which ends their follow and leaves no block behind. X's docs
// list both endpoints as Enterprise-only, so a pay-per-use app is usually
// refused: the first refusal ends the run and nobody is blocked. People you
// follow are never soft-blocked, because a block would also unfollow them.
import { DAY, sleep } from './util.js';
import { XError, explainError } from './xapi.js';
import { withPrefix } from './store.js';

export const API_DEFAULTS = Object.freeze({ intervalSec: 65, dailyCap: 300 });

class Stopped extends Error {}

export function refusalText(e) {
  const code = `${e.status}${e.reason ? `, ${e.reason}` : ''}`;
  return `X refused to block through the API (${code}). X lists block and unblock as Enterprise-only, so apps on pay-per-use cannot use them. Nobody was blocked. Use "On your Followers page" or "One by one" instead.`;
}

export function createApiRemover({ x, store, onUpdate = () => {}, now = () => Date.now() }) {
  const status = { running: false, phase: 'idle', done: 0, total: 0, current: '', waitUntil: 0, message: '', error: null, refused: null };
  let ctrl = null;
  const set = (patch) => {
    Object.assign(status, patch);
    onUpdate(status);
  };

  async function pause(ms, why, abortable = true) {
    const until = now() + Math.max(0, ms);
    set({ waitUntil: until, message: why });
    const signal = abortable ? ctrl.signal : undefined;
    while (now() < until && !signal?.aborted) await sleep(Math.min(1000, until - now()), signal);
    set({ waitUntil: 0, message: '' });
    if (signal?.aborted) throw new Stopped();
  }

  // DELETE is safe to repeat, so this keeps going until X confirms, even after Stop.
  async function unblock(meId, id) {
    for (let failures = 0; ; ) {
      try {
        await x.call('DELETE', `/2/users/${meId}/blocking/${id}`);
        await store.remove(`pend:${id}`);
        return;
      } catch (e) {
        if (e instanceof XError && e.status === 429) {
          await pause(e.retryAt - now() + 1000, 'X rate limit: waiting to unblock', false);
          continue;
        }
        if (++failures > 5) throw e;
        await pause(3000 * failures, 'Unblock failed, retrying', false);
      }
    }
  }

  async function block(meId, id) {
    for (let failures = 0; ; ) {
      try {
        return await x.call('POST', `/2/users/${meId}/blocking`, { body: { target_user_id: id } });
      } catch (e) {
        if (e instanceof XError && e.status === 429) {
          await pause(e.retryAt - now() + 1000, 'X rate limit: waiting');
          continue;
        }
        if (e instanceof XError && e.retryable && ++failures <= 3) {
          await pause(3000 * failures, 'Block failed, retrying');
          continue;
        }
        throw e;
      }
    }
  }

  async function releasePending(meId) {
    for (const [id, p] of await withPrefix(store, 'pend:')) {
      set({ current: p.u, message: 'Undoing a block left by an interrupted run' });
      await unblock(meId, id);
    }
  }

  async function guarded(fn) {
    if (status.running) return;
    ctrl = new AbortController();
    set({ running: true, error: null, refused: null, message: '' });
    try {
      await fn();
    } catch (e) {
      set({ phase: 'error', error: explainError(e) });
    } finally {
      set({ running: false, waitUntil: 0, current: '' });
    }
  }

  const release = () =>
    guarded(async () => {
      set({ phase: 'releasing' });
      await releasePending((await store.get('me')).id);
      set({ phase: 'idle' });
    });

  const run = (candidates, { intervalSec, dailyCap }) =>
    guarded(async () => {
      if (!(await x.hasScope('block.write'))) {
        set({ phase: 'error', error: 'Sweep needs permission to block for this. Press "Allow blocking" and approve it on X.' });
        return;
      }
      const me = await store.get('me');
      await releasePending(me.id);
      const marks = await withPrefix(store, 'rm:');
      const today = [...marks.values()].filter((r) => r.via === 'api' && now() - r.at < DAY).length;
      const room = Math.max(0, dailyCap - today);
      const list = candidates.filter((u) => u.youFollow === false && !marks.has(u.id)).slice(0, room);
      set({ phase: room ? 'running' : 'capped', done: 0, total: list.length });

      for (const [i, u] of list.entries()) {
        if (ctrl.signal.aborted) break;
        set({ current: u.username });
        await store.set(`pend:${u.id}`, { at: now(), u: u.username });
        try {
          await block(me.id, u.id);
        } catch (e) {
          const refused = e instanceof XError && e.status >= 400 && e.status < 500 && e.status !== 429;
          if (refused) {
            await store.remove(`pend:${u.id}`);
            if ([401, 403, 404].includes(e.status)) {
              set({ phase: 'refused', refused: refusalText(e) });
              return;
            }
            throw e;
          }
          await unblock(me.id, u.id); // outcome unknown: make sure nothing stays blocked
          if (e instanceof Stopped) break;
          throw e;
        }
        await unblock(me.id, u.id);
        await store.set(`rm:${u.id}`, { at: now(), via: 'api', u: u.username, n: u.name, a: u.avatar });
        set({ done: status.done + 1 });
        if (i < list.length - 1) {
          try {
            await pause(intervalSec * 1000, 'Pacing to stay under X limits');
          } catch (e) {
            if (e instanceof Stopped) break;
            throw e;
          }
        }
      }
      if (status.phase === 'running') set({ phase: ctrl.signal.aborted ? 'stopped' : 'done' });
    });

  return { status, run, release, stop: () => ctrl?.abort() };
}
