import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, normalizeRules, signals, reasonText, prepare, SORTS, DEFAULT_RULES } from '../extension/lib/rules.js';
import { slimUser } from '../extension/lib/scan.js';
import { snowflakeTime, snowflakeFrom, DAY } from '../extension/lib/util.js';

const NOW = Date.UTC(2026, 8, 25);
const user = (over = {}) => ({
  id: '1', username: 'someone', name: 'Someone', avatar: '', defaultAvatar: false, verified: false, verifiedType: null,
  followers: 120, following: 300, posts: 40, createdAt: '2019-01-01T00:00:00.000Z', lastPostId: snowflakeFrom(NOW - 10 * DAY),
  protected: false, bio: 'hi', youFollow: false, subscribesToYou: false, ...over,
});
const rules = normalizeRules();

test('the requested rule: no checkmark and under 5,000 followers goes', () => {
  assert.deepEqual(classify(user(), rules, null, NOW), { action: 'remove', reason: 'rule' });
  assert.equal(classify(user({ followers: 4999 }), rules, null, NOW).action, 'remove');
});

test('any checkmark stays, whatever the follower count', () => {
  for (const verifiedType of ['blue', 'business', 'government']) {
    assert.deepEqual(classify(user({ verified: true, verifiedType, followers: 3 }), rules, null, NOW), { action: 'keep', reason: 'verified' });
  }
  assert.equal(classify(user({ verified: true, verifiedType: null }), rules, null, NOW).reason, 'verified');
});

test('5,000 followers or more stays even without Premium', () => {
  assert.deepEqual(classify(user({ followers: 5000 }), rules, null, NOW), { action: 'keep', reason: 'followers' });
  assert.equal(classify(user({ followers: 250_000 }), rules, null, NOW).action, 'keep');
});

test('extra keeps: people you follow, subscribers, the manual list', () => {
  assert.equal(classify(user({ youFollow: true }), rules, null, NOW).reason, 'following');
  assert.equal(classify(user({ subscribesToYou: true }), rules, null, NOW).reason, 'subscriber');
  assert.equal(classify(user({ verified: true, verifiedType: 'blue' }), rules, new Map([['1', {}]]), NOW).reason, 'manual');
  const off = normalizeRules({ keepFollowing: false, keepSubscribers: false });
  assert.equal(classify(user({ youFollow: true, subscribesToYou: true }), off, null, NOW).action, 'remove');
});

test('rules can be switched off, and the threshold moves', () => {
  const noCheck = normalizeRules({ keepVerified: false });
  assert.equal(classify(user({ verified: true, verifiedType: 'blue' }), noCheck, null, NOW).action, 'remove');
  const noMin = normalizeRules({ minOn: false });
  assert.equal(classify(user({ followers: 90_000 }), noMin, null, NOW).action, 'remove');
  const min100 = normalizeRules({ minFollowers: 100 });
  assert.equal(classify(user({ followers: 120 }), min100, null, NOW).reason, 'followers');
});

test('the optional inactivity rule spares recent posters only', () => {
  const r = normalizeRules({ inactiveOn: true, inactiveDays: 365 });
  assert.equal(classify(user(), r, null, NOW).reason, 'active');
  assert.equal(classify(user({ lastPostId: snowflakeFrom(NOW - 400 * DAY) }), r, null, NOW).action, 'remove');
  assert.equal(classify(user({ posts: 0, lastPostId: null }), r, null, NOW).action, 'remove');
  assert.equal(classify(user({ lastPostId: null, protected: true }), r, null, NOW).reason, 'hidden');
});

test('normalizeRules clamps and keeps defaults', () => {
  assert.deepEqual(normalizeRules({}), { ...DEFAULT_RULES });
  assert.equal(normalizeRules({ minFollowers: -5 }).minFollowers, 1);
  assert.equal(normalizeRules({ minFollowers: 'x' }).minFollowers, 5000);
  assert.equal(normalizeRules({ inactiveDays: 99999 }).inactiveDays, 3650);
});

test('reason text reads well', () => {
  assert.equal(reasonText({ reason: 'rule' }, user(), rules), 'No checkmark, under 5,000 followers');
  assert.equal(reasonText({ reason: 'verified' }, user({ verified: true, verifiedType: 'business' }), rules), 'Verified business');
  assert.equal(reasonText({ reason: 'followers' }, user({ followers: 12_400 }), rules), '12k followers');
});

test('dead signals and ordering', () => {
  const ghost = user({ id: '2', posts: 0, lastPostId: null, defaultAvatar: true, bio: '', followers: 2 });
  const quiet = user({ id: '3', lastPostId: snowflakeFrom(NOW - 800 * DAY) });
  const live = user({ id: '4' });
  const keys = signals(ghost, NOW).map((s) => s.key);
  assert.deepEqual(keys, ['noposts', 'avatar', 'nobio', 'tiny']);
  assert.equal(signals(quiet, NOW)[0].label, 'last post 2y ago');
  const order = prepare([live, quiet, ghost], NOW).sort(SORTS.dead.cmp).map((u) => u.id);
  assert.deepEqual(order, ['2', '3', '4']);
});

test('snowflake ids carry their time', () => {
  const t = Date.UTC(2024, 5, 1, 12);
  assert.equal(snowflakeTime(snowflakeFrom(t)), t);
  assert.equal(snowflakeTime('20'), 1288834974657); // pre-2010 id: at least that old
  assert.equal(snowflakeTime('not a number'), null);
});

test('slimUser maps an X API user object', () => {
  const u = slimUser({
    id: '42', username: 'abc', name: 'A', verified: true, verified_type: 'blue', description: 'bio',
    profile_image_url: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png',
    public_metrics: { followers_count: 10, following_count: 20, tweet_count: 0 },
    connection_status: ['following', 'followed_by'], subscription: { subscribes_to_you: false },
  });
  assert.equal(u.defaultAvatar, true);
  assert.equal(u.verifiedType, 'blue');
  assert.equal(u.youFollow, true);
  assert.equal(u.subscribesToYou, false);
  assert.equal(slimUser({ id: 1, verified_type: 'none' }).verifiedType, null);
  assert.equal(slimUser({ id: 1 }).youFollow, null);
});
