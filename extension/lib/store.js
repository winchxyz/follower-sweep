// One async key-value shape over chrome.storage.local, and an in-memory twin for tests.
//
// Keys: app (client id), auth (tokens), me, cfg, rules, fmeta + f:<n> (followers in
// chunks), scan + sp:<n> (a scan in progress), rm:<id> (marked removed), keep:<id>
// (kept by hand), pend:<id> (API soft block not yet undone), verdicts + queue (for
// the x.com content script). Per-id keys let the app and the content script write
// at the same time without overwriting each other.

export function chromeStore(area = chrome.storage.local) {
  return {
    get: async (key) => (await area.get(key))[key] ?? null,
    getMany: (keys) => area.get(keys),
    set: (key, value) => area.set({ [key]: value }),
    setMany: (obj) => area.set(obj),
    remove: (keys) => area.remove(keys),
    keys: async () => (area.getKeys ? area.getKeys() : Object.keys(await area.get(null))),
  };
}

export function memoryStore(init = {}) {
  const m = new Map(Object.entries(structuredClone(init)));
  const copy = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    async get(key) { return m.has(key) ? copy(m.get(key)) : null; },
    async getMany(keys) {
      const out = {};
      for (const k of keys) if (m.has(k)) out[k] = copy(m.get(k));
      return out;
    },
    async set(key, value) { m.set(key, copy(value)); },
    async setMany(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, copy(v)); },
    async remove(keys) { for (const k of [].concat(keys)) m.delete(k); },
    async keys() { return [...m.keys()]; },
  };
}

export async function withPrefix(store, prefix) {
  const keys = (await store.keys()).filter((k) => k.startsWith(prefix));
  if (!keys.length) return new Map();
  const got = await store.getMany(keys);
  return new Map(Object.entries(got).map(([k, v]) => [k.slice(prefix.length), v]));
}
