import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// Customer sign-in, sign-out and session summary over HTTP (identity design 5.2, 6.2 to 6.4,
// 6.8, 8.6; slice 2): the real guards, controllers and use cases, with identity's database ports
// as in-memory fakes (no database in `pnpm test`). The PostgreSQL run is
// test/db/customer-sign-in.db-spec.ts. A fresh application per test: the rate limiter counts in
// memory. nestjs-pino captures the log lines of a file's first application only, so the logging
// test comes first.

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Shopper@Example.com';
const fakes = new IdentityFakes();

/** Market-specific numbers of config/markets/AU.json and test/fixtures/markets/ZZ.json. */
const NUMBERS: Record<string, { absoluteSeconds: number; limit: number; blockSeconds: number }> = {
  AU: { absoluteSeconds: 43_200 * 60, limit: 5, blockSeconds: 15 * 60 },
  ZZ: { absoluteSeconds: 20_160 * 60, limit: 4, blockSeconds: 20 * 60 },
};

function seed(code: string, overrides: Partial<AccountState> = {}): void {
  const now = Temporal.Instant.from('2026-10-01T00:00:00Z');
  fakes.seedAccount({
    id: `0199${code === 'AU' ? 'aaaa' : 'bbbb'}-0000-7000-8000-000000000001` as Id<'Account'>,
    marketId: code as AccountState['marketId'],
    population: 'customer',
    email: { typed: EMAIL, normalized: EMAIL.toLowerCase() },
    displayName: null,
    status: 'active',
    emailVerifiedAt: now,
    existingAccountNoticeAt: null,
    signedUpAt: now,
    createdAt: now,
    version: 1,
    credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: now },
    ...overrides,
  });
}

const cookieOf = (setCookie: unknown): string => {
  const [line] = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return line!.split(';', 1)[0]!;
};

describe('customer sessions over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());
  const signIn = (market: string, body: unknown, headers: Record<string, string> = {}) =>
    http()
      .post('/identity/customer/sign-in')
      .set({ 'x-market-id': market, ...headers })
      .send(body as object);

  async function boot(env: Record<string, string> = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      override: (builder) => fakes.override(builder),
    }));
  }

  beforeEach(() => fakes.reset());
  afterEach(async () => {
    await app.close();
  });

  it('logs outcomes with the correlation id, never the email, the password or the token', async () => {
    await boot();
    seed('AU');

    const response = await signIn('AU', { email: EMAIL, password: PASSWORD });

    expect(response.status).toBe(200);
    const correlationId = response.headers['x-correlation-id'] as string;
    const line = logLines.find((l) => l.msg === 'identity.customer-sign-in');
    expect(line).toMatchObject({ outcome: 'signed-in', marketId: 'AU', correlationId });
    const all = JSON.stringify(logLines);
    expect(all).not.toContain(EMAIL.toLowerCase());
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(cookieOf(response.headers['set-cookie']).split('=')[1]);
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const name = `__Host-session-customer-${code}`;

    it('signs in: the __Host- cookie with the absolute lifetime, the CSRF token in the body', async () => {
      await boot();
      seed(code);

      const response = await signIn(code, { email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        code: 'signed-in',
        csrfToken: expect.any(String) as unknown,
      });
      const [setCookie] = response.headers['set-cookie'] as unknown as string[];
      expect(setCookie).toMatch(
        new RegExp(
          `^${name}=ms1_[A-Za-z0-9_-]{43}; Max-Age=${NUMBERS[code]!.absoluteSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax$`,
        ),
      );
      expect(JSON.stringify(response.body)).not.toContain(cookieOf(setCookie).split('=')[1]);
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('describes the session, then signs out with the CSRF token and the cookie stops working', async () => {
      await boot();
      seed(code);
      const signedIn = await signIn(code, { email: EMAIL, password: PASSWORD });
      const cookie = cookieOf(signedIn.headers['set-cookie']);
      const csrfToken = (signedIn.body as { csrfToken: string }).csrfToken;

      const summary = await http()
        .get('/identity/customer/session')
        .set({ 'x-market-id': code, cookie });
      expect(summary.status).toBe(200);
      expect(summary.body).toMatchObject({
        population: 'customer',
        sellerId: null,
        email: EMAIL,
        displayName: null,
        permissionKeys: [],
        csrfToken,
        session: { idleTimeoutSeconds: expect.any(Number) as unknown },
      });
      expect(summary.headers['cache-control']).toBe('no-store');

      const withoutToken = await http()
        .post('/identity/customer/sign-out')
        .set({ 'x-market-id': code, cookie });
      expect(withoutToken.status).toBe(403);
      expect(withoutToken.body).toEqual({ statusCode: 403, code: 'request.csrf' });

      const signedOut = await http()
        .post('/identity/customer/sign-out')
        .set({ 'x-market-id': code, cookie, 'x-csrf-token': csrfToken });
      expect(signedOut.status).toBe(200);
      expect(signedOut.body).toEqual({ code: 'signed-out' });
      expect(String(signedOut.headers['set-cookie'])).toContain(`${name}=; Max-Age=0;`);

      const after = await http()
        .get('/identity/customer/session')
        .set({ 'x-market-id': code, cookie });
      expect(after.status).toBe(401);
      expect(after.body).toEqual({ statusCode: 401, code: 'session.invalid' });
      expect(String(after.headers['set-cookie'])).toContain(`${name}=; Max-Age=0;`);
    });

    it('answers access.unauthenticated without a session cookie', async () => {
      await boot();

      const response = await http().get('/identity/customer/session').set({ 'x-market-id': code });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ statusCode: 401, code: 'access.unauthenticated' });
    });

    it("refuses a session in another Market's cookie name and Market (AC 20)", async () => {
      await boot();
      seed(code);
      const other = TEST_MARKETS.find((m) => m !== code)!;
      const signedIn = await signIn(code, { email: EMAIL, password: PASSWORD });
      const token = cookieOf(signedIn.headers['set-cookie']).split('=')[1]!;

      // The same cookie under this Market's name, sent to the other Market: not read at all.
      const ignored = await http()
        .get('/identity/customer/session')
        .set({ 'x-market-id': other, cookie: `${name}=${token}` });
      expect(ignored.body).toEqual({ statusCode: 401, code: 'access.unauthenticated' });
      // Under the other Market's name: read, and rejected.
      const rejected = await http()
        .get('/identity/customer/session')
        .set({ 'x-market-id': other, cookie: `__Host-session-customer-${other}=${token}` });
      expect(rejected.body).toEqual({ statusCode: 401, code: 'session.invalid' });
    });

    it('refuses a repeated cookie name (HF7) and any Authorization header (HF14)', async () => {
      await boot();
      seed(code);
      const signedIn = await signIn(code, { email: EMAIL, password: PASSWORD });
      const cookie = cookieOf(signedIn.headers['set-cookie']);

      const tossed = await http()
        .get('/identity/customer/session')
        .set({ 'x-market-id': code, cookie: `${cookie}; ${name}=ms1_${'X'.repeat(43)}` });
      expect(tossed.body).toEqual({ statusCode: 401, code: 'session.invalid' });

      const bearer = await http()
        .get('/identity/customer/session')
        .set({ 'x-market-id': code, cookie, authorization: 'Bearer x' });
      expect(bearer.body).toEqual({ statusCode: 401, code: 'session.invalid' });
      const signInWithHeader = await signIn(
        code,
        { email: EMAIL, password: PASSWORD },
        { authorization: 'Basic eDp5' },
      );
      expect(signInWithHeader.status).toBe(401);
    });

    it('refuses a sign-in from a refused origin with request.csrf (HF14)', async () => {
      await boot();
      seed(code);

      const crossSite = await signIn(
        code,
        { email: EMAIL, password: PASSWORD },
        { 'sec-fetch-site': 'cross-site' },
      );
      const otherOrigin = await signIn(
        code,
        { email: EMAIL, password: PASSWORD },
        { origin: 'https://evil.example' },
      );

      expect([crossSite.status, otherOrigin.status]).toEqual([403, 403]);
      expect(crossSite.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect(fakes.verified).toBe(0);
    });

    it('answers credentials.invalid, then request.throttled with Retry-After at the limit', async () => {
      await boot();
      seed(code);
      const { limit, blockSeconds } = NUMBERS[code]!;

      for (let n = 0; n < limit; n += 1) {
        const failed = await signIn(code, { email: EMAIL, password: 'wrong password' });
        expect(failed.status).toBe(401);
        expect(failed.body).toEqual({ statusCode: 401, code: 'credentials.invalid' });
      }
      // A forged forwarded header changes nothing: the origin is the socket's (HF3, I4).
      const throttled = await signIn(
        code,
        { email: EMAIL, password: PASSWORD },
        { 'x-forwarded-for': '198.51.100.77', forwarded: 'for=198.51.100.77' },
      );

      expect(throttled.status).toBe(429);
      expect(throttled.body).toMatchObject({ code: 'request.throttled' });
      const retryAfter = Number(throttled.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(blockSeconds);
    });

    it('answers email-verification-required to an unverified account, after the password (I5)', async () => {
      await boot();
      seed(code, { emailVerifiedAt: null });

      const wrong = await signIn(code, { email: EMAIL, password: 'wrong password' });
      const right = await signIn(code, { email: EMAIL, password: PASSWORD });

      expect(wrong.body).toEqual({ statusCode: 401, code: 'credentials.invalid' });
      expect(right.status).toBe(403);
      expect(right.body).toEqual({ statusCode: 403, code: 'email-verification-required' });
      expect(right.headers['set-cookie']).toBeUndefined();
    });

    it('refuses a body with an unknown field or of another media type', async () => {
      await boot();

      const unknown = await signIn(code, { email: EMAIL, password: PASSWORD, remember: true });
      const text = await http()
        .post('/identity/customer/sign-in')
        .set({ 'x-market-id': code, 'content-type': 'text/plain' })
        .send('email=x');

      expect(unknown.status).toBe(400);
      expect(unknown.body).toMatchObject({ code: 'validation.failed' });
      expect(text.status).toBe(415);
    });
  });

  it('documents the three routes in the OpenAPI document', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });

    const response = await http().get('/docs-json').expect(200);
    const paths = (
      response.body as { paths: Record<string, Record<string, { responses: object }>> }
    ).paths;

    expect(Object.keys(paths['/identity/customer/sign-in']?.post?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '415',
      '429',
      '503',
    ]);
    expect(paths['/identity/customer/sign-out']?.post).toBeDefined();
    expect(paths['/identity/customer/session']?.get).toBeDefined();
  });
});
