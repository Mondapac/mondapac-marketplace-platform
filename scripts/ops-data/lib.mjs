// Shared helpers of the operational test data loader (and the demo seed it replaces): an HTTP
// client that behaves like a panel's server, a TOTP generator for the admin's second factor and a
// Mailpit reader. No dependencies, and nothing imported from apps/*.
import crypto from 'node:crypto';

export const API = process.env.OPS_API_URL ?? process.env.DEMO_API_URL ?? 'http://localhost:3000';
export const MAILPIT = process.env.MAIL_CATCHER_URL ?? 'http://localhost:8025';
/** The default Market of a Session; the loader passes the Market it runs for. */
export const MARKET = process.env.DEMO_MARKET ?? 'AU';
export const ORIGINS = {
  admin: process.env.ADMIN_PANEL_ORIGIN ?? 'http://admin.localhost:3002',
  seller: process.env.SELLER_PANEL_ORIGIN ?? 'http://seller.localhost:3001',
  customer: process.env.STOREFRONT_ORIGIN ?? 'http://storefront.localhost:3003',
};

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text) {
  let bits = '';
  for (const ch of text.replace(/=+$/, '').toUpperCase())
    bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 code (SHA-1, 6 digits, 30 s) for a base32 secret. */
export function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[19] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lastStepUsed = new Map();

/**
 * A code the loader has not sent yet. The API accepts a code once and counts a replayed one as a
 * failure towards the account's lock (BUG-035), so when this secret's code for the current 30 s
 * step was already sent, wait for the next step instead of sending it again.
 */
export async function freshCode(secret) {
  const step = () => Math.floor(Date.now() / 30000);
  if (lastStepUsed.get(secret) === step()) await sleep(30000 - (Date.now() % 30000) + 1500);
  lastStepUsed.set(secret, step());
  return totp(secret);
}

// Step-up proofs stay valid for 5 minutes on the server (STEP_UP_PROOF_MINUTES); reuse one for 4.
const STEP_UP_REUSE_MS = 4 * 60_000;
const stepUpProofs = new WeakMap();

/** One signed-in (or anonymous) client of one route population. */
export class Session {
  constructor(population, market = MARKET) {
    this.population = population;
    this.market = market;
    this.cookie = undefined;
    this.csrf = undefined;
  }

  async request(method, path, body) {
    // The API throttles sign-ins; wait out a short Retry-After instead of failing the seed.
    for (let attempt = 0; ; attempt += 1) {
      const answer = await this.#send(method, path, body);
      const wait = answer.status === 429 ? answer.body?.details?.retryAfterSeconds : undefined;
      if (wait === undefined || attempt >= 5 || wait > 90) return answer;
      await sleep((wait + 1) * 1000);
    }
  }

  async #send(method, path, body) {
    const headers = {
      'x-market-id': this.market,
      origin: ORIGINS[this.population],
      'sec-fetch-site': 'same-origin',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const response = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    const set = response.headers.getSetCookie?.() ?? [];
    if (set.length > 0) this.cookie = set[0].split(';', 1)[0];
    if (parsed?.csrfToken) this.csrf = parsed.csrfToken;
    return { status: response.status, body: parsed };
  }

  get = (path) => this.request('GET', path);
  post = (path, body = {}) => this.request('POST', path, body);
  put = (path, body = {}) => this.request('PUT', path, body);
  patch = (path, body = {}) => this.request('PATCH', path, body);

  /**
   * Uses a link from a mail (a token read out of Mailpit). The worker sends the mail first and
   * stores the link's hash in the unit after it (identity design 9: mail is at least once), so
   * for a moment the mail can be in Mailpit while the API still answers link.rejected. That
   * answer is retried for up to 15 s; any other answer, or the last one, is returned as it is.
   */
  async requestLink(method, path, body) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const answer = await this.request(method, path, body);
      if (answer.body?.code !== 'link.rejected' || Date.now() >= deadline) return answer;
      await sleep(500);
    }
  }

  /** Like requestLink, but throws unless the status is 2xx. */
  async okLink(method, path, body) {
    return Session.#checked(method, path, await this.requestLink(method, path, body));
  }

  /** Like request, but throws unless the status is 2xx. */
  async ok(method, path, body) {
    return Session.#checked(method, path, await this.request(method, path, body));
  }

  static #checked(method, path, answer) {
    if (answer.status < 200 || answer.status > 299) {
      throw new Error(
        `${method} ${path} -> ${answer.status} ${JSON.stringify(answer.body).slice(0, 400)}`,
      );
    }
    return answer.body;
  }
}

/** The newest mail to an address whose text matches a pattern, polled for up to 30 s. */
export async function mailLink(address, pattern, { since = 0 } = {}) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const list = await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)
    ).json();
    for (const message of list.messages ?? []) {
      if (Date.parse(message.Created) < since) continue;
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json();
      const found = pattern.exec(full.Text ?? '');
      if (found) return found[1];
    }
    await sleep(500);
  }
  throw new Error(`no mail to ${address} matching ${pattern} within 30 s (is the worker running?)`);
}

/**
 * Signs the admin in with password and TOTP code; returns the session. A code is accepted once,
 * so when the current one was used a moment ago the sign-in waits for the next 30 s step.
 */
export async function adminSignIn(email, password, secret, market = MARKET) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = new Session('admin', market);
    const first = await session.ok('POST', '/identity/admin/sign-in', { email, password });
    if (first.code !== 'second-factor-required')
      throw new Error(`admin sign-in: unexpected ${first.code}`);
    const done = await session.request('POST', '/identity/admin/second-factor', {
      challengeToken: first.challengeToken,
      code: await freshCode(secret),
    });
    if (done.status === 200 && done.body.code === 'signed-in') return session;
    if (attempt === 1 || done.body?.code !== 'second-factor.invalid') {
      throw new Error(`admin second factor: ${done.status} ${JSON.stringify(done.body)}`);
    }
    await sleep(30000 - (Date.now() % 30000) + 1500);
  }
  throw new Error('unreachable');
}

/**
 * Gives a seller its main business activity (ADR-0040 decision 4: an approval needs one). The
 * Market's first active activity is used; one named "General" is created when none exists. The
 * change needs a fresh two-step code for its action, and a code is accepted once, so a code is never sent twice
 * (freshCode), and one proof serves every seller for 4 minutes.
 */
export async function setMainActivity(admin, secret, sellerId, locale) {
  const list = await admin.ok('GET', '/catalog/admin/business-activities?status=active&limit=1');
  let activityId = list.items[0]?.id;
  if (activityId === undefined) {
    const created = await admin.ok('POST', '/catalog/admin/business-activities', {
      names: { [locale]: 'General' },
    });
    activityId = created.activity.id;
  }
  const actionKey = 'sellers.business-activity.change';
  const proofs = stepUpProofs.get(admin) ?? new Map();
  stepUpProofs.set(admin, proofs);
  if (Date.now() - (proofs.get(actionKey) ?? 0) > STEP_UP_REUSE_MS) {
    const verified = await admin.request('POST', '/identity/admin/step-up/verify', {
      actionKey,
      code: await freshCode(secret),
    });
    if (verified.status >= 300)
      throw new Error(`step-up: ${verified.status} ${JSON.stringify(verified.body)}`);
    proofs.set(actionKey, Date.now());
  }
  await admin.ok('PUT', `/sellers/admin/${sellerId}/business-activities`, {
    mainActivityId: activityId,
    extraActivityIds: [],
    reason: 'Loader: main activity before approval',
  });
}
