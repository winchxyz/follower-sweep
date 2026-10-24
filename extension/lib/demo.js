// Deterministic sample followers shaped like X API v2 user objects. Used by the
// app's "sample followers" mode and by the local X stub in dev/. The handles are
// made up; the app never links sample accounts to x.com.
import { DAY, snowflakeFrom } from './util.js';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Maya', 'Leo', 'Ava', 'Noah', 'Iris', 'Kai', 'Zoe', 'Omar', 'Nina', 'Theo', 'Lena', 'Arlo', 'Mira', 'Jude', 'Sana', 'Ezra', 'Rosa', 'Finn', 'Yara', 'Milo', 'Ines', 'Ravi', 'Cleo', 'Hugo', 'Tess', 'Ivan', 'Luz', 'Otto', 'Nadia', 'Remy'];
const WA = ['quiet', 'lunar', 'amber', 'rusty', 'static', 'velvet', 'paper', 'neon', 'hollow', 'copper', 'misty', 'solar', 'idle', 'tiny', 'woven', 'feral', 'polar', 'dusty', 'silver', 'salty'];
const WB = ['otter', 'fern', 'signal', 'pixel', 'harbor', 'moth', 'cactus', 'ledger', 'comet', 'tulip', 'raven', 'glyph', 'orbit', 'pebble', 'lantern', 'maple', 'vector', 'koi', 'ember', 'sprout'];
const BIOS = ['coffee, code and cats', 'building things on the internet', 'gm', 'design, type, tea', 'here for the memes', 'founder (stealth)', 'photography and long walks', 'crypto since 2017', 'reply guy', 'learning in public', 'dad. runner. nerd.', 'views are my own', 'NFA', 'shipping every day', 'music, film, football'];
export const DEFAULT_AVATAR = 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png';

export const SAMPLE_ME = { id: '1000', username: 'sample_account', name: 'Sample Account' };

function gauss(r) {
  let u = 0, v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const logn = (r, mu, sigma) => Math.round(Math.exp(mu + sigma * gauss(r)));
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// A small abstract avatar: coloured field, one shape.
export function avatarSvg(seed) {
  const h = hashStr(String(seed));
  const hue = h % 360, hue2 = (hue + 40 + (h >> 9) % 120) % 360;
  const bg = `hsl(${hue} 42% 58%)`, fg = `hsl(${hue2} 60% 86%)`;
  const shapes = [
    `<circle cx="24" cy="24" r="11" fill="${fg}"/>`,
    `<path d="M24 11 37 35H11z" fill="${fg}"/>`,
    `<rect x="14" y="14" width="20" height="20" rx="3" fill="${fg}"/>`,
    `<path d="M10 30c5-9 9-9 14 0s9 9 14 0" stroke="${fg}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="${bg}"/>${shapes[(h >> 3) % shapes.length]}</svg>`;
}
export const avatarDataUri = (seed) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(avatarSvg(seed));

export function sampleFollowers({ count = 1250, seed = 7, now = Date.now(), avatar = avatarDataUri } = {}) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const taken = new Set();
  const users = [];
  for (let i = 0; i < count; i++) {
    let username;
    do {
      const a = pick(WA), b = pick(WB), n = Math.floor(r() * 9000) + 100;
      username = r() < 0.6 ? `${a}_${b}${n}` : `${pick(FIRST).toLowerCase()}${b}${n % 1000}`;
      username = username.slice(0, 15);
    } while (taken.has(username));
    taken.add(username);

    const id = String(1_400_000_000_000 + i * 7919);
    const roll = r();
    const kind = roll < 0.09 ? 'blue' : roll < 0.098 ? 'business' : roll < 0.1 ? 'government' : null;
    let followers = r() < 0.03 ? 5000 + logn(r, 9.4, 1.1) : logn(r, 4.2, 1.8);
    if (kind) followers = Math.round(followers * (1.5 + r() * 3));
    const following = r() < 0.06 ? 2000 + Math.floor(r() * 5000) : logn(r, 5.4, 1.1);
    const silent = r() < 0.22;
    const posts = silent ? 0 : Math.max(1, logn(r, 5.2, 2));
    const isProtected = r() < 0.05;
    const created = now - (r() < 0.04 ? r() * 30 * DAY : (30 + r() * 17 * 365) * DAY);
    let last = null;
    if (posts > 0) {
      const q = r();
      const back = q < 0.45 ? r() * 30 * DAY : q < 0.65 ? (30 + r() * 335) * DAY : (365 + r() * 5 * 365) * DAY;
      last = Math.min(now - 60_000, Math.max(created + 3_600_000, now - back));
    }
    const defaultAvatar = r() < (silent ? 0.35 : 0.08);
    const name = r() < 0.7 ? `${pick(FIRST)} ${String.fromCharCode(65 + Math.floor(r() * 26))}.` : `${cap(pick(WA))} ${cap(pick(WB))}`;
    const youFollow = r() < 0.07;

    users.push({
      id,
      username,
      name,
      description: r() < 0.32 ? '' : pick(BIOS),
      created_at: new Date(created).toISOString(),
      profile_image_url: defaultAvatar ? DEFAULT_AVATAR : avatar(id),
      protected: isProtected,
      verified: Boolean(kind),
      verified_type: kind || 'none',
      public_metrics: { followers_count: followers, following_count: following, tweet_count: posts, listed_count: Math.floor(followers / 250) },
      ...(last && !isProtected ? { most_recent_tweet_id: snowflakeFrom(last) } : {}),
      connection_status: youFollow ? ['following', 'followed_by'] : ['followed_by'],
      subscription: { subscribes_to_you: r() < 0.004 },
    });
  }
  return users;
}
