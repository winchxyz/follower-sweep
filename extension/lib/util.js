// Helpers shared by the app page, the X stub and the tests. No chrome.* here.

export const DAY = 86_400_000;
const SNOWFLAKE_EPOCH = 1288834974657n;

export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
  });
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

export function fmtCompact(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

export function fmtUsd(n) {
  if (!n) return '$0';
  if (n < 0.01) return 'under $0.01';
  return '$' + (n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US'));
}

export function ago(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const days = Math.floor(ms / DAY);
  if (days < 1) return 'today';
  if (days < 45) return `${days}d ago`;
  const months = Math.round(days / 30.44);
  if (months < 18) return `${months}mo ago`;
  return `${Math.floor(days / 365.25)}y ago`;
}

export function fmtDuration(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Post and user ids since late 2010 are snowflakes: the top bits are a timestamp.
// Older ids carry no time; those posts are at least as old as the epoch.
export function snowflakeTime(id) {
  try {
    const n = BigInt(id);
    if (n < 10n ** 15n) return Number(SNOWFLAKE_EPOCH);
    return Number((n >> 22n) + SNOWFLAKE_EPOCH);
  } catch {
    return null;
  }
}

export const snowflakeFrom = (ms) => ((BigInt(Math.floor(ms)) - SNOWFLAKE_EPOCH) << 22n).toString();

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function sha256b64url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64url(new Uint8Array(digest));
}

export function clampInt(value, min, max, fallback = min) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
