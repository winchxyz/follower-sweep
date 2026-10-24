// A local stand-in for the parts of X that Sweep uses: OAuth 2.0 with PKCE,
// /2/users/me, followers, following, and block/unblock. For tests only; it
// serves made-up followers from extension/lib/demo.js.
//
//   node dev/stub-x.mjs [--port 3799] [--followers 1250] [--blocks deny|allow]
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sampleFollowers, avatarSvg } from '../extension/lib/demo.js';

const USER_FIELDS = ['affiliation', 'connection_status', 'created_at', 'description', 'entities', 'id', 'is_identity_verified', 'location', 'most_recent_tweet_id', 'name', 'parody', 'pinned_tweet_id', 'profile_banner_url', 'profile_image_url', 'protected', 'public_metrics', 'receives_your_dm', 'subscription', 'subscription_type', 'url', 'username', 'verified', 'verified_followers_count', 'verified_type', 'withheld'];
const b64url = (buf) => buf.toString('base64url');
const token = (p) => p + b64url(randomBytes(18));

export async function startStubX(opts = {}) {
  const o = {
    port: 0,
    followers: 1250,
    seed: 7,
    clientId: 'demo-client-id-123',
    blocks: 'deny', // 'deny' answers like a pay-per-use app; 'allow' like Enterprise
    rejectFields: [], // user.fields to refuse with X's 400, to test the fallback
    throttleAfter: 0, // answer 429 once after this many follower pages
    tokenTtl: 7200,
    rejectUserContext: false, // plain 401 on every user-token call, like a pay-per-use app X hasn't enrolled
    appBearer: 'AAAAAAAAAAAAAAAAAAAAAstub-app-bearer-token-0123456789', // the app-only Bearer Token

    ...opts,
  };
  let base = '';
  let followers = [];
  let followingIds = new Set();
  const me = {
    id: '1000', username: 'sample_account', name: 'Sample Account', verified: false, verified_type: 'none', subscription_type: 'None',
    created_at: '2014-03-02T10:00:00.000Z', description: 'the stub account', protected: false,
    public_metrics: { followers_count: 0, following_count: 0, tweet_count: 812, listed_count: 3 },
    profile_image_url: '',
  };
  // Runs once the port is known, so avatar URLs point at this server.
  function seed() {
    followers = sampleFollowers({ count: o.followers, seed: o.seed, now: Date.now(), avatar: (id) => `${base}/avatar/${id}.svg` });
    followingIds = new Set(followers.filter((u) => u.connection_status.includes('following')).map((u) => u.id));
    for (let i = 0; i < 25; i++) followingIds.add(String(9_000_000 + i));
    me.public_metrics.following_count = followingIds.size;
  }

  const codes = new Map(); // code -> { challenge, redirect, scope }
  const access = new Map(); // token -> { scope, exp }
  const refresh = new Map(); // token -> scope
  const blocked = new Set();
  const log = [];
  let followerPages = 0;
  let throttled = false;

  function issue(scope) {
    const at = token('at_'), rt = token('rt_');
    access.set(at, { scope, exp: Date.now() + o.tokenTtl * 1000 });
    refresh.set(rt, scope);
    return { token_type: 'bearer', expires_in: o.tokenTtl, access_token: at, scope, refresh_token: rt };
  }

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'x-rate-limit-limit, x-rate-limit-remaining, x-rate-limit-reset, x-transaction-id',
  };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'x-transaction-id': randomBytes(8).toString('hex'), ...cors, ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
  const rate = (remaining = 299) => ({ 'x-rate-limit-limit': '300', 'x-rate-limit-remaining': String(remaining), 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900) });

  // App-only Bearer Token works on public reads; user-only endpoints refuse it like X does.
  function auth(req, res, { userOnly = false } = {}) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (m && m[1] === o.appBearer) {
      if (!userOnly) return { scope: '', app: true };
      send(res, 403, {
        title: 'Unsupported Authentication', status: 403, type: 'https://api.twitter.com/2/problems/unsupported-authentication',
        detail: 'Authenticating with OAuth 2.0 Application-Only is forbidden for this endpoint.  Supported authentication types are [OAuth 1.0a User Context, OAuth 2.0 User Context].',
      });
      return null;
    }
    const t = m && access.get(m[1]);
    if (!t || t.exp < Date.now() || o.rejectUserContext) {
      send(res, 401, { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' });
      return null;
    }
    return t;
  }

  function pickFields(u, fields) {
    const out = { id: u.id, name: u.name, username: u.username };
    for (const f of fields) if (f in u) out[f] = u[f];
    return out;
  }

  function checkFields(res, url) {
    const fields = (url.searchParams.get('user.fields') || '').split(',').filter(Boolean);
    const allowed = USER_FIELDS.filter((f) => !o.rejectFields.includes(f));
    const bad = fields.filter((f) => !allowed.includes(f));
    if (bad.length) {
      send(res, 400, {
        errors: [{ parameters: { 'user.fields': bad }, message: `The \`user.fields\` query parameter value [${bad.join(',')}] is not one of [${allowed.join(',')}]` }],
        title: 'Invalid Request', detail: 'One or more parameters to your request was invalid.', type: 'https://api.twitter.com/2/problems/invalid-request',
      });
      return null;
    }
    return fields;
  }

  function page(res, url, list, fields) {
    const max = Math.min(1000, Math.max(1, Number(url.searchParams.get('max_results')) || 100));
    const tok = url.searchParams.get('pagination_token');
    const start = tok ? parseInt(tok.slice(1), 36) : 0;
    if (tok && (!tok.startsWith('P') || Number.isNaN(start))) return send(res, 400, { title: 'Invalid Request', detail: 'pagination_token is invalid' });
    const slice = list.slice(start, start + max);
    const meta = { result_count: slice.length };
    if (start + max < list.length) meta.next_token = 'P' + (start + max).toString(36);
    send(res, 200, { data: slice.map((u) => pickFields(u, fields)), meta }, rate(Math.max(1, 299 - followerPages)));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const path = url.pathname;
    log.push(`${req.method} ${path}`);
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (path === '/i/oauth2/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== o.clientId) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        return res.end('<h1>Something went wrong</h1><p>You weren\'t able to give access to the App.</p>');
      }
      if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('state')) return send(res, 400, { error: 'invalid_request' });
      const code = token('code_');
      codes.set(code, { challenge: p.get('code_challenge'), redirect: p.get('redirect_uri'), scope: p.get('scope') });
      const back = new URL(p.get('redirect_uri'));
      back.searchParams.set('state', p.get('state'));
      back.searchParams.set('code', code);
      res.writeHead(302, { Location: back.toString(), ...cors });
      return res.end();
    }

    if (path === '/2/oauth2/token' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      if (f.get('client_id') !== o.clientId) return send(res, 401, { error: 'unauthorized_client', error_description: 'Missing valid authorization header' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code'));
        codes.delete(f.get('code'));
        const challenge = c && b64url(createHash('sha256').update(f.get('code_verifier') || '').digest());
        if (!c || c.redirect !== f.get('redirect_uri') || challenge !== c.challenge) return send(res, 400, { error: 'invalid_request', error_description: 'Value passed for the authorization code was invalid.' });
        return send(res, 200, issue(c.scope));
      }
      if (f.get('grant_type') === 'refresh_token') {
        const scope = refresh.get(f.get('refresh_token'));
        refresh.delete(f.get('refresh_token'));
        if (!scope) return send(res, 400, { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' });
        return send(res, 200, issue(scope));
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    if (path === '/2/oauth2/revoke' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      access.delete(f.get('token'));
      refresh.delete(f.get('token'));
      return send(res, 200, { revoked: true });
    }

    const avatar = /^\/avatar\/(\d+)\.svg$/.exec(path);
    if (avatar) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600', ...cors });
      return res.end(avatarSvg(avatar[1]));
    }

    if (path === '/__state') return send(res, 200, { blocked: [...blocked], followers: followers.length, log: log.slice(-200), options: o });
    if (path === '/__admin' && req.method === 'POST') {
      Object.assign(o, JSON.parse((await readBody(req)) || '{}'));
      return send(res, 200, { ok: true, options: o });
    }

    const meNow = () => ({ ...me, public_metrics: { ...me.public_metrics, followers_count: followers.length } });
    if (path === '/2/users/me' && req.method === 'GET') {
      if (!auth(req, res, { userOnly: true })) return;
      const fields = checkFields(res, url);
      if (!fields) return;
      return send(res, 200, { data: pickFields(meNow(), fields) }, rate());
    }

    const byName = /^\/2\/users\/by\/username\/([A-Za-z0-9_]{1,15})$/.exec(path);
    if (byName && req.method === 'GET') {
      if (!auth(req, res)) return;
      const fields = checkFields(res, url);
      if (!fields) return;
      if (byName[1].toLowerCase() !== me.username) {
        return send(res, 200, { errors: [{ value: byName[1], detail: `Could not find user with username: [${byName[1]}].`, title: 'Not Found Error', resource_type: 'user', parameter: 'username', type: 'https://api.twitter.com/2/problems/resource-not-found' }] });
      }
      return send(res, 200, { data: pickFields(meNow(), fields) }, rate());
    }

    const rel = /^\/2\/users\/(\d+)\/(followers|following|blocking)(?:\/(\d+))?$/.exec(path);
    if (rel && rel[1] === me.id) {
      const t = auth(req, res);
      if (!t) return;
      const [, , what, target] = rel;
      if (what === 'followers' && req.method === 'GET') {
        const fields = checkFields(res, url);
        if (!fields) return;
        followerPages++;
        if (o.throttleAfter && followerPages > o.throttleAfter && !throttled) {
          throttled = true;
          return send(res, 429, { title: 'Too Many Requests', detail: 'Too Many Requests', type: 'about:blank', status: 429 },
            { 'x-rate-limit-limit': '300', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(Math.ceil(Date.now() / 1000) + 1) });
        }
        return page(res, url, followers, fields);
      }
      if (what === 'following' && req.method === 'GET') {
        const list = [...followingIds].map((id) => followers.find((u) => u.id === id) || { id, name: `Friend ${id}`, username: `friend_${id.slice(-4)}` });
        return page(res, url, list, []);
      }
      if (what === 'blocking') {
        if (t.app || !t.scope.split(' ').includes('block.write')) return send(res, 403, { title: 'Forbidden', detail: 'Missing scope block.write', type: 'about:blank', status: 403 });
        if (req.method === 'POST' && !target) {
          if (o.blocks !== 'allow') {
            return send(res, 403, {
              client_id: o.clientId, title: 'Client Forbidden', reason: 'client-not-enrolled', required_enrollment: 'Appropriate Level of API Access',
              detail: 'When authenticating requests to the X API v2 endpoints, you must use keys and tokens from an App with the appropriate level of access.',
              type: 'https://api.twitter.com/2/problems/client-forbidden',
            });
          }
          const body = JSON.parse((await readBody(req)) || '{}');
          blocked.add(String(body.target_user_id));
          const i = followers.findIndex((u) => u.id === String(body.target_user_id));
          if (i >= 0) followers.splice(i, 1); // a block ends their follow
          followingIds.delete(String(body.target_user_id));
          return send(res, 200, { data: { blocking: true } }, rate());
        }
        if (req.method === 'DELETE' && target) {
          blocked.delete(target);
          return send(res, 200, { data: { blocking: false } }, rate());
        }
      }
    }
    send(res, 404, { title: 'Not Found Error', detail: `No route ${req.method} ${path}`, type: 'https://api.twitter.com/2/problems/resource-not-found' });
  });

  await new Promise((resolve) => server.listen(o.port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  seed();
  return {
    url: base,
    options: o,
    get followers() { return followers; },
    blocked,
    log,
    expire: () => access.forEach((t) => (t.exp = 0)),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, d) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const stub = await startStubX({ port: Number(arg('port', 3799)), followers: Number(arg('followers', 1250)), blocks: arg('blocks', 'deny') });
  console.log(`X stub on ${stub.url} (client_id demo-client-id-123, ${stub.followers.length} followers, blocks ${stub.options.blocks})`);
}
