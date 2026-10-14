// Shared helpers of the demo seed: an HTTP client that behaves like a panel's server, a TOTP
// generator for the admin's second factor and a Mailpit reader. No dependencies.
import crypto from 'node:crypto';

export const API = process.env.DEMO_API_URL ?? 'http://localhost:3000';
export const MAILPIT = process.env.MAIL_CATCHER_URL ?? 'http://localhost:8025';
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

/** One signed-in (or anonymous) client of one route population. */
export class Session {
  constructor(population) {
    this.population = population;
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
      'x-market-id': MARKET,
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

  /** Like request, but throws unless the status is 2xx. */
  async ok(method, path, body) {
    const answer = await this.request(method, path, body);
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
export async function adminSignIn(email, password, secret) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = new Session('admin');
    const first = await session.ok('POST', '/identity/admin/sign-in', { email, password });
    if (first.code !== 'second-factor-required')
      throw new Error(`admin sign-in: unexpected ${first.code}`);
    const done = await session.request('POST', '/identity/admin/second-factor', {
      challengeToken: first.challengeToken,
      code: totp(secret),
    });
    if (done.status === 200 && done.body.code === 'signed-in') return session;
    if (attempt === 1 || done.body?.code !== 'second-factor.invalid') {
      throw new Error(`admin second factor: ${done.status} ${JSON.stringify(done.body)}`);
    }
    await sleep(30000 - (Date.now() % 30000) + 1500);
  }
  throw new Error('unreachable');
}
