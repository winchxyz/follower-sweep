// The official X API, nothing else: OAuth 2.0 with PKCE for sign-in, then v2
// endpoints with the user's token. Works in the extension page (host permission
// for api.x.com) and in Node for the tests (against dev/stub-x.mjs).
import { randomToken, sha256b64url } from './util.js';

export const X_AUTH_BASE = 'https://x.com';
export const X_API_BASE = 'https://api.x.com';
export const READ_SCOPES = ['tweet.read', 'users.read', 'follows.read', 'offline.access'];
export const BLOCK_SCOPES = ['block.read', 'block.write'];
const ME_FIELDS = ['created_at', 'description', 'name', 'profile_image_url', 'public_metrics', 'username', 'verified', 'verified_type', 'subscription_type'];

export class XError extends Error {
  constructor({ status = 0, step = '', title = '', detail = '', reason = '', retryAt = 0, body = null, method = '', path = '', txid = '' } = {}) {
    super(detail || title || (status ? `HTTP ${status}` : 'Request failed'));
    this.name = 'XError';
    Object.assign(this, { status, step, title, detail, reason, retryAt, body, method, path, txid });
  }
  get retryable() {
    return this.status === 0 || this.status >= 500;
  }
}

// Always says what X actually answered, so a problem on X's side can be told apart from one here.
export function explainError(e) {
  if (!(e instanceof XError)) return e?.message || String(e);
  const said = [...new Set([e.title, e.detail, e.reason].filter(Boolean))].join(', ');
  // X support traces a failing call by its x-transaction-id header.
  const answer = `X answered ${e.status}${e.path ? ` to ${e.method} ${e.path}` : ''}${said ? ` (${said})` : ''}.${e.txid ? ` X request id: ${e.txid}.` : ''}`;
  if (e.step === 'authorize') return `Sign-in did not finish.${e.detail ? ` ${e.detail}` : ''}`;
  if (e.step === 'setup' || (e.step === 'profile' && !e.status)) return e.detail;
  if (e.status === 0) return `Could not reach X.${e.detail ? ` ${e.detail}` : ''}`;
  if (e.step === 'token') return `X refused the sign-in. ${answer} Check the Client ID, the callback URI and the app type.`;
  if (e.status === 401 && (e.reason === 'expired' || e.reason === 'not-connected')) return e.detail;
  if (e.status === 401) return `X did not accept the token. ${answer}`;
  if (e.status === 402) return `${answer} The app is out of credits or hit its spending limit. Add credits or raise the limit at console.x.com, then try again.`;
  if (e.status === 403 && /client-not-enrolled/i.test(`${e.reason} ${e.detail}`)) {
    return `${answer} In console.x.com, check that the app sits in a project with billing set up.`;
  }
  if (e.status === 403) return `X refused the request. ${answer}`;
  if (e.status === 429) return 'X rate limit reached.';
  if (e.status >= 500) return `X had a server error. ${answer}`;
  return answer;
}

function readRate(headers) {
  const num = (k) => {
    const v = headers.get(k);
    return v == null || v === '' ? null : Number(v);
  };
  const reset = num('x-rate-limit-reset');
  return { limit: num('x-rate-limit-limit'), remaining: num('x-rate-limit-remaining'), reset: reset ? reset * 1000 : null };
}

function errorFrom(status, json, text, rate, method, path, txid) {
  const first = Array.isArray(json?.errors) ? json.errors[0] : null;
  return new XError({
    txid,
    status,
    title: json?.title || first?.title || '',
    detail: json?.detail || first?.message || first?.detail || json?.error_description || (json ? '' : String(text).slice(0, 300)),
    reason: json?.reason || first?.reason || json?.error || '',
    retryAt: status === 429 ? rate.reset || Date.now() + 60_000 : 0,
    body: json,
    method,
    path,
  });
}

const parse = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

export function mentionsField(e, param) {
  return e instanceof XError && e.status === 400 && `${JSON.stringify(e.body || '')} ${e.detail}`.includes(param);
}

// Given X's "value [a] is not one of [b,c,...]" error, keep only accepted fields.
export function acceptedFields(e, fields) {
  const text = `${JSON.stringify(e.body || '')} ${e.detail}`;
  const m = text.match(/is not one of \[([^\]]*)\]/);
  if (m) {
    const ok = new Set(m[1].split(',').map((s) => s.trim()));
    const kept = fields.filter((f) => ok.has(f));
    if (kept.length && kept.length < fields.length) return kept;
  }
  return null;
}

export function createXApi({ store, redirectUri, launchAuth, getBases, fetchImpl = (...a) => fetch(...a) }) {
  let refreshing = null;
  const bases = async () => (getBases ? getBases() : { authBase: X_AUTH_BASE, apiBase: X_API_BASE });

  async function app() {
    const a = await store.get('app');
    if (!a?.clientId) throw new XError({ step: 'setup', detail: 'Add the Client ID of your X app first.' });
    return a;
  }

  async function tokenRequest(params) {
    const a = await app();
    const { apiBase } = await bases();
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (a.clientSecret) headers.Authorization = 'Basic ' + btoa(`${a.clientId}:${a.clientSecret}`);
    let res;
    try {
      res = await fetchImpl(`${apiBase}/2/oauth2/token`, { method: 'POST', headers, body: new URLSearchParams({ ...params, client_id: a.clientId }) });
    } catch (err) {
      throw new XError({ status: 0, step: 'token', detail: err.message });
    }
    const text = await res.text();
    const json = parse(text);
    if (!res.ok || !json?.access_token) {
      throw new XError({ status: res.status || 0, step: 'token', reason: json?.error || '', detail: json?.error_description || json?.error || String(text).slice(0, 300), body: json });
    }
    const prev = await store.get('auth');
    const auth = {
      access_token: json.access_token,
      refresh_token: json.refresh_token || prev?.refresh_token || null,
      scope: json.scope || prev?.scope || '',
      expires_at: Date.now() + (Number(json.expires_in) || 7200) * 1000,
    };
    await store.set('auth', auth);
    return auth;
  }

  async function connect({ withBlocks = false } = {}) {
    const a = await app();
    const { authBase } = await bases();
    const verifier = randomToken(48);
    const state = randomToken(24);
    const scopes = withBlocks ? [...READ_SCOPES, ...BLOCK_SCOPES] : READ_SCOPES;
    const url = `${authBase}/i/oauth2/authorize?` + new URLSearchParams({
      response_type: 'code',
      client_id: a.clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
      code_challenge: await sha256b64url(verifier),
      code_challenge_method: 'S256',
    });
    let back;
    try {
      back = await launchAuth(url);
    } catch (err) {
      throw new XError({ step: 'authorize', detail: err?.message || String(err) });
    }
    const u = new URL(back);
    if (u.searchParams.get('error')) {
      throw new XError({ step: 'authorize', detail: u.searchParams.get('error_description') || u.searchParams.get('error') });
    }
    if (u.searchParams.get('state') !== state) throw new XError({ step: 'authorize', detail: 'The answer from X did not match this sign-in. Try again.' });
    await tokenRequest({ grant_type: 'authorization_code', code: u.searchParams.get('code') || '', redirect_uri: redirectUri, code_verifier: verifier });
    try {
      return await me();
    } catch (e) {
      // A token X won't accept is no sign-in: drop it so the next attempt starts clean.
      await revoke();
      if (e instanceof XError && !e.step) e.step = 'profile';
      throw e;
    }
  }

  function refresh(auth) {
    if (!auth.refresh_token) return Promise.reject(new XError({ status: 401, reason: 'expired', detail: 'Your X sign-in expired. Sign in again.' }));
    refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh_token })
      .catch(async (e) => {
        if (e.status === 400 || e.status === 401) {
          await store.remove('auth');
          throw new XError({ status: 401, reason: 'expired', detail: 'Your X sign-in expired. Sign in again.' });
        }
        throw e;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  // 'user': signed in with OAuth 2.0, so reading your followers bills as owned reads.
  // 'app': only the app's Bearer Token is set (for when X refuses user sign-in);
  // public reads at the normal price, nothing that needs you signed in.
  async function mode() {
    if ((await store.get('auth'))?.access_token) return 'user';
    return (await store.get('app'))?.bearer ? 'app' : null;
  }

  async function accessToken(force = false) {
    const auth = await store.get('auth');
    if (auth?.access_token) {
      if (!force && auth.expires_at - Date.now() > 60_000) return auth.access_token;
      return (await refresh(auth)).access_token;
    }
    const bearer = (await store.get('app'))?.bearer;
    if (bearer) return bearer;
    throw new XError({ status: 401, reason: 'not-connected', detail: 'Not signed in to X.' });
  }

  async function call(method, path, { query, body } = {}, retried = false) {
    const { apiBase } = await bases();
    const url = new URL(apiBase + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const token = await accessToken(retried);
    const headers = { Authorization: `Bearer ${token}` };
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new XError({ status: 0, detail: err.message });
    }
    const rate = readRate(res.headers);
    const text = await res.text();
    const json = parse(text);
    if (res.status === 401 && !retried) {
      const auth = await store.get('auth');
      if (auth?.refresh_token) return call(method, path, { query, body }, true);
    }
    if (!res.ok) throw errorFrom(res.status, json, text, rate, method, path, res.headers.get('x-transaction-id') || '');
    return { json, rate, status: res.status };
  }

  async function me() {
    const handle = (await store.get('app'))?.handle || '';
    const viaApp = (await mode()) === 'app';
    const path = viaApp ? `/2/users/by/username/${encodeURIComponent(handle)}` : '/2/users/me';
    let fields = ME_FIELDS;
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await call('GET', path, { query: { 'user.fields': fields.join(',') } });
        break;
      } catch (e) {
        const next = attempt < 2 && mentionsField(e, 'user.fields') ? acceptedFields(e, fields) : null;
        if (!next) throw e;
        fields = next;
      }
    }
    const d = r.json?.data;
    if (!d?.id) throw new XError({ step: 'profile', detail: viaApp ? `X found no account @${handle}.` : 'X returned no profile.' });
    const m = d.public_metrics || {};
    const profile = {
      id: String(d.id),
      username: d.username,
      name: d.name || d.username,
      avatar: d.profile_image_url || '',
      followers: Number(m.followers_count) || 0,
      following: Number(m.following_count) || 0,
      verifiedType: d.verified_type && d.verified_type !== 'none' ? d.verified_type : null,
      subscriptionType: d.subscription_type || null,
      at: Date.now(),
    };
    await store.set('me', profile);
    return profile;
  }

  async function revoke() {
    const auth = await store.get('auth');
    await store.remove('auth');
    if (!auth) return;
    try {
      const a = await app();
      const { apiBase } = await bases();
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (a.clientSecret) headers.Authorization = 'Basic ' + btoa(`${a.clientId}:${a.clientSecret}`);
      for (const [token, hint] of [[auth.refresh_token, 'refresh_token'], [auth.access_token, 'access_token']]) {
        if (token) await fetchImpl(`${apiBase}/2/oauth2/revoke`, { method: 'POST', headers, body: new URLSearchParams({ token, token_type_hint: hint, client_id: a.clientId }) });
      }
    } catch {
      // The local token is gone either way; X also drops tokens when the app is removed.
    }
  }

  async function hasScope(scope) {
    const auth = await store.get('auth');
    return (auth?.scope || '').split(/\s+/).includes(scope);
  }

  return { connect, call, me, revoke, hasScope, mode };
}
