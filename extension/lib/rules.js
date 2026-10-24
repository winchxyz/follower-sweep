// Who stays and who goes. Pure functions over the slim users that scan.js stores.
import { DAY, snowflakeTime, fmtCompact, fmtInt, ago, clampInt } from './util.js';

export const DEFAULT_RULES = Object.freeze({
  keepVerified: true, // any checkmark: blue (X Premium), gold (business), grey (government)
  minOn: true,
  minFollowers: 5000, // keep accounts with at least this many followers
  keepFollowing: true, // keep people you follow back
  keepSubscribers: true, // keep people who pay for a subscription to you
  inactiveOn: false,
  inactiveDays: 365, // when on: only remove accounts silent for this many days
});

const bool = (v, d) => (v === undefined ? d : Boolean(v));

export function normalizeRules(r = {}) {
  const d = DEFAULT_RULES;
  return {
    keepVerified: bool(r.keepVerified, d.keepVerified),
    minOn: bool(r.minOn, d.minOn),
    minFollowers: clampInt(r.minFollowers, 1, 1e9, d.minFollowers),
    keepFollowing: bool(r.keepFollowing, d.keepFollowing),
    keepSubscribers: bool(r.keepSubscribers, d.keepSubscribers),
    inactiveOn: bool(r.inactiveOn, d.inactiveOn),
    inactiveDays: clampInt(r.inactiveDays, 1, 3650, d.inactiveDays),
  };
}

const CHECKS = ['blue', 'business', 'government'];
export const isVerified = (u) => u.verified === true || CHECKS.includes(u.verifiedType);

export function checkKind(u) {
  if (u.verifiedType === 'business' || u.verifiedType === 'government') return u.verifiedType;
  return isVerified(u) ? 'blue' : null;
}

export const lastPostAt = (u) => (u.lastPostId ? snowflakeTime(u.lastPostId) : null);

// First matching keep rule wins; everyone else is a removal candidate.
export function classify(u, rules, keep, now = Date.now()) {
  if (keep?.has(u.id)) return { action: 'keep', reason: 'manual' };
  if (rules.keepVerified && isVerified(u)) return { action: 'keep', reason: 'verified' };
  if (rules.minOn && u.followers >= rules.minFollowers) return { action: 'keep', reason: 'followers' };
  if (rules.keepFollowing && u.youFollow === true) return { action: 'keep', reason: 'following' };
  if (rules.keepSubscribers && u.subscribesToYou === true) return { action: 'keep', reason: 'subscriber' };
  if (rules.inactiveOn && u.posts > 0) {
    const last = lastPostAt(u);
    if (last == null) return { action: 'keep', reason: 'hidden' };
    if (now - last < rules.inactiveDays * DAY) return { action: 'keep', reason: 'active' };
  }
  return { action: 'remove', reason: 'rule' };
}

const KIND = { blue: 'X Premium', business: 'Verified business', government: 'Government' };

export function reasonText(c, u, rules) {
  switch (c.reason) {
    case 'manual': return 'Kept by you';
    case 'verified': return KIND[checkKind(u)];
    case 'followers': return `${fmtCompact(u.followers)} followers`;
    case 'following': return 'You follow them';
    case 'subscriber': return 'Subscribes to you';
    case 'active': return `Posted in the last ${fmtInt(rules.inactiveDays)} days`;
    case 'hidden': return 'Last post not visible';
    default: {
      const parts = [];
      if (rules.keepVerified) parts.push('no checkmark');
      if (rules.minOn) parts.push(`under ${fmtInt(rules.minFollowers)} followers`);
      const s = parts.join(', ') || 'matches no keep rule';
      return s[0].toUpperCase() + s.slice(1);
    }
  }
}

// Hints that an account is dead. They only order the list; the rules decide.
export function signals(u, now = Date.now()) {
  const out = [];
  const last = lastPostAt(u);
  if (u.posts === 0) out.push({ key: 'noposts', label: 'no posts', w: 3 });
  else if (last != null && now - last > 365 * DAY) out.push({ key: 'stale', label: `last post ${ago(now - last)}`, w: 2 });
  else if (last != null && now - last > 90 * DAY) out.push({ key: 'quiet', label: `last post ${ago(now - last)}`, w: 1 });
  if (u.defaultAvatar) out.push({ key: 'avatar', label: 'default avatar', w: 2 });
  if (!u.bio) out.push({ key: 'nobio', label: 'no bio', w: 1 });
  if (u.followers < 10) out.push({ key: 'tiny', label: `${u.followers} follower${u.followers === 1 ? '' : 's'}`, w: 1 });
  if (u.following >= 1000 && u.followers * 20 < u.following) out.push({ key: 'spray', label: `follows ${fmtCompact(u.following)}`, w: 1 });
  const age = u.createdAt ? now - Date.parse(u.createdAt) : null;
  if (age != null && age >= 0 && age < 30 * DAY) out.push({ key: 'new', label: 'new account', w: 1 });
  return out;
}

export const deadScore = (u, now) => signals(u, now).reduce((s, x) => s + x.w, 0);

const BIG = 9e15;
export const SORTS = {
  dead: { label: 'Deadest first', cmp: (a, b) => b._score - a._score || a.followers - b.followers || a._i - b._i },
  fewest: { label: 'Fewest followers', cmp: (a, b) => a.followers - b.followers || a._i - b._i },
  most: { label: 'Most followers', cmp: (a, b) => b.followers - a.followers || a._i - b._i },
  recent: { label: 'Followed you most recently', cmp: (a, b) => a._i - b._i },
  silent: { label: 'Silent longest', cmp: (a, b) => (a._last ?? BIG) - (b._last ?? BIG) || a._i - b._i },
};

// Adds the sort keys used above. _last: -1 for never posted, BIG when hidden.
export function prepare(users, now = Date.now()) {
  users.forEach((u, i) => {
    u._i = i;
    u._sig = signals(u, now);
    u._score = u._sig.reduce((s, x) => s + x.w, 0);
    u._last = u.posts === 0 ? -1 : lastPostAt(u) ?? BIG;
  });
  return users;
}
