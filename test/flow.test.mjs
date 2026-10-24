// The whole path against a local stub of X: sign-in with PKCE, the scan and its
// fallbacks, re-scan bookkeeping, and the API soft-block in both answers X can give.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStubX } from '../dev/stub-x.mjs';
import { memoryStore, withPrefix } from '../extension/lib/store.js';
import { createXApi, explainError } from '../extension/lib/xapi.js';
import { createScanner, loadFollowers, loadList } from '../extension/lib/scan.js';
import { createApiRemover } from '../extension/lib/apiremove.js';
import { classify, normalizeRules, prepare, SORTS } from '../extension/lib/rules.js';

async function setup(stubOpts = {}) {
  const stub = await startStubX(stubOpts);
  const store = memoryStore({ app: { clientId: 'demo-client-id-123' } });
  const x = createXApi({
    store,
    redirectUri: 'https://ojfmjajpdhdpjekhnlmjpphmmmngochn.chromiumapp.org/x',
    getBases: async () => ({ authBase: stub.url, apiBase: stub.url }),
    launchAuth: async (url) => (await fetch(url, { redirect: 'manual' })).headers.get('location'),
  });
  return { stub, store, x, scanner: createScanner({ x, store }), remover: createApiRemover({ x, store }) };
}

const candidates = async (store, rules = normalizeRules()) => {
  const users = prepare(await loadFollowers(store));
  return users.filter((u) => classify(u, rules, null).action === 'remove').sort(SORTS.dead.cmp);
};

test('sign in, scan every follower, keep the requested ones', async (t) => {
  const { stub, store, x, scanner } = await setup({ followers: 2345 });
  t.after(() => stub.close());

  const me = await x.connect();
  assert.equal(me.username, 'sample_account');
  assert.match((await store.get('auth')).scope, /follows\.read/);
  assert.equal(await x.hasScope('block.write'), false);

  await scanner.run();
  assert.equal(scanner.status.phase, 'done', scanner.status.error);
  const users = await loadFollowers(store);
  assert.equal(users.length, 2345);
  assert.equal(new Set(users.map((u) => u.id)).size, 2345);
  assert.equal((await store.get('fmeta')).mutualSource, 'connection_status');
  assert.equal(scanner.status.reads, 2346); // the profile plus each follower once

  const rules = normalizeRules();
  for (const u of users) {
    const c = classify(u, rules, null);
    if (u.verified || u.followers >= 5000 || u.youFollow || u.subscribesToYou) assert.equal(c.action, 'keep', u.username);
    else assert.equal(c.action, 'remove', u.username);
  }
  assert.deepEqual((await store.keys()).filter((k) => k.startsWith('sp:') || k === 'scan'), []);
});

test('drops user fields X refuses, and reads your following list when X leaves out who you follow', async (t) => {
  const { stub, store, x, scanner } = await setup({ rejectFields: ['subscription', 'connection_status'] });
  t.after(() => stub.close());
  await x.connect();
  await scanner.run();
  assert.equal(scanner.status.phase, 'done', scanner.status.error);
  const meta = await store.get('fmeta');
  assert.ok(!meta.fields.includes('subscription') && !meta.fields.includes('connection_status'));
  assert.equal(meta.mutualSource, 'following');
  const users = await loadFollowers(store);
  const followed = new Set(stub.followers.filter((u) => u.connection_status.includes('following')).map((u) => u.id));
  assert.ok(followed.size > 0);
  for (const u of users) assert.equal(u.youFollow, followed.has(u.id));
});

test('waits out a 429 and refreshes an expired token', async (t) => {
  const { stub, store, x, scanner } = await setup({ followers: 3100, throttleAfter: 1 });
  t.after(() => stub.close());
  await x.connect();
  const first = (await store.get('auth')).access_token;
  stub.expire();
  const started = Date.now();
  await scanner.run();
  assert.equal(scanner.status.phase, 'done', scanner.status.error);
  assert.equal((await loadFollowers(store)).length, 3100);
  assert.ok(Date.now() - started >= 900, 'should have waited for the rate-limit reset');
  assert.notEqual((await store.get('auth')).access_token, first);
});

test('a re-scan confirms removals and puts back anyone still following', async (t) => {
  const { stub, store, x, scanner } = await setup();
  t.after(() => stub.close());
  await x.connect();
  await scanner.run();
  const [gone1, gone2, stays] = await candidates(store);
  const at = Date.now() - 1000;
  for (const u of [gone1, gone2, stays]) await store.set(`rm:${u.id}`, { at, via: 'manual', u: u.username });
  for (const u of [gone1, gone2]) stub.followers.splice(stub.followers.findIndex((f) => f.id === u.id), 1);

  await scanner.run({ fresh: true });
  const marks = await withPrefix(store, 'rm:');
  assert.ok(marks.get(gone1.id).confirmed && marks.get(gone2.id).confirmed);
  assert.equal(marks.get(gone1.id).n, gone1.name);
  assert.equal(marks.has(stays.id), false);
  const r = await store.get('lastReconcile');
  assert.equal(r.confirmed, 2);
  assert.deepEqual(r.names, [stays.username]);
});

test('API removal stops at X\'s refusal and leaves nobody blocked', async (t) => {
  const { stub, store, x, scanner, remover } = await setup({ blocks: 'deny' });
  t.after(() => stub.close());
  await x.connect({ withBlocks: true });
  await scanner.run();
  await remover.run(await candidates(store), { intervalSec: 0, dailyCap: 10 });
  assert.equal(remover.status.phase, 'refused');
  assert.match(remover.status.refused, /Enterprise-only/);
  assert.equal(stub.blocked.size, 0);
  assert.equal((await withPrefix(store, 'pend:')).size, 0);
  assert.equal((await withPrefix(store, 'rm:')).size, 0);
});

test('API removal soft-blocks when X allows it, skips people you follow, respects the daily cap', async (t) => {
  const { stub, store, x, scanner, remover } = await setup({ blocks: 'allow' });
  t.after(() => stub.close());
  await x.connect({ withBlocks: true });
  await scanner.run();
  // With "keep people you follow" off they are candidates; put them first: the soft block must skip them.
  const list = (await candidates(store, normalizeRules({ keepFollowing: false }))).sort((a, b) => Number(b.youFollow) - Number(a.youFollow));
  assert.equal(list[0].youFollow, true);
  const before = stub.followers.length;
  await remover.run(list, { intervalSec: 0, dailyCap: 6 });
  assert.equal(remover.status.phase, 'done', remover.status.error);
  assert.equal(remover.status.done, 6);
  assert.equal(stub.followers.length, before - 6);
  assert.equal(stub.blocked.size, 0, 'every block was undone');
  const marks = await withPrefix(store, 'rm:');
  assert.equal(marks.size, 6);
  for (const [id, m] of marks) {
    assert.equal(m.via, 'api');
    assert.equal(list.find((u) => u.id === id).youFollow, false);
  }
  await remover.run(list, { intervalSec: 0, dailyCap: 6 });
  assert.equal(remover.status.phase, 'capped');
});

test('refuses to soft-block without the block permission', async (t) => {
  const { stub, store, x, scanner, remover } = await setup({ blocks: 'allow' });
  t.after(() => stub.close());
  await x.connect();
  await scanner.run();
  await remover.run(await candidates(store), { intervalSec: 0, dailyCap: 5 });
  assert.equal(remover.status.phase, 'error');
  assert.match(remover.status.error, /permission to block/);
  assert.equal(stub.blocked.size, 0);
});

test('a token X issues but then refuses: says so, and leaves no half sign-in behind', async (t) => {
  const { stub, store, x } = await setup({ rejectUserContext: true });
  t.after(() => stub.close());
  const err = await x.connect().then(() => null, (e) => e);
  assert.equal(err?.status, 401);
  assert.equal(err.step, 'profile');
  assert.match(explainError(err), /X answered 401 to GET \/2\/users\/me \(Unauthorized\)\. X request id: [0-9a-f]{16}\./);
  assert.equal(await store.get('auth'), null);
  assert.equal(await store.get('me'), null);
});

test('scans with the app Bearer Token while X refuses user sign-in', async (t) => {
  const { stub, store, x, scanner, remover } = await setup({ rejectUserContext: true });
  t.after(() => stub.close());
  await store.set('app', { clientId: 'demo-client-id-123', bearer: stub.options.appBearer, handle: 'Sample_Account' });
  assert.equal(await x.mode(), 'app');
  assert.equal((await x.me()).id, '1000');
  await scanner.run();
  assert.equal(scanner.status.phase, 'done', scanner.status.error);
  const meta = await store.get('fmeta');
  assert.deepEqual(meta.fields.filter((f) => ['connection_status', 'subscription'].includes(f)), []);
  assert.equal(meta.mutualSource, 'following');
  const users = await loadFollowers(store);
  assert.equal(users.length, 1250);
  const followed = new Set(stub.followers.filter((u) => u.connection_status.includes('following')).map((u) => u.id));
  for (const u of users) assert.equal(u.youFollow, followed.has(u.id));
  await remover.run(await candidates(store), { intervalSec: 0, dailyCap: 5 });
  assert.equal(remover.status.phase, 'error'); // blocking needs a user sign-in
  assert.equal(stub.blocked.size, 0);

  await store.set('app', { clientId: 'demo-client-id-123', bearer: stub.options.appBearer, handle: 'nobody_here' });
  const err = await x.me().then(() => null, (e) => e);
  assert.match(explainError(err), /no account @nobody_here/);
});

test('scans who you follow and confirms unfollows on the next scan', async (t) => {
  const { stub, store, x, scanner } = await setup();
  t.after(() => stub.close());
  await x.connect();
  await scanner.run();
  await scanner.runFollowing();
  assert.equal(scanner.status.phase, 'done', scanner.status.error);
  const following = await loadList(store, 'g', 'gmeta');
  assert.equal(following.length, stub.followingIds.size);
  const followerIds = new Set((await loadFollowers(store)).map((u) => u.id));
  const notBack = following.filter((u) => !followerIds.has(u.id));
  assert.equal(notBack.length, 25); // the stub follows 25 accounts that don't follow back
  for (const u of following) assert.equal(u.followsYou, followerIds.has(u.id));

  const [gone, stays] = notBack;
  const at = Date.now() - 1000;
  await store.setMany({ [`uf:${gone.id}`]: { at, via: 'manual', u: gone.username }, [`uf:${stays.id}`]: { at, via: 'manual', u: stays.username } });
  stub.followingIds.delete(gone.id);
  await scanner.runFollowing();
  const marks = await withPrefix(store, 'uf:');
  assert.ok(marks.get(gone.id).confirmed);
  assert.equal(marks.has(stays.id), false);
});

test('undoes a block left behind by an interrupted run', async (t) => {
  const { stub, store, x, scanner, remover } = await setup({ blocks: 'allow' });
  t.after(() => stub.close());
  await x.connect({ withBlocks: true });
  await scanner.run();
  const [victim] = await candidates(store);
  stub.blocked.add(victim.id);
  await store.set(`pend:${victim.id}`, { at: Date.now(), u: victim.username });
  await remover.release();
  assert.equal(stub.blocked.has(victim.id), false);
  assert.equal((await withPrefix(store, 'pend:')).size, 0);
});
