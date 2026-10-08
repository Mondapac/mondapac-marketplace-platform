import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { SeedSystemRoles } from '../src/modules/identity/application/use-cases/seed-system-roles.use-case';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// Seller sign-up, email confirmation, limited sign-in, session, status and sign-out over HTTP
// (identity design 3.3, 5.2, 6.1 to 6.4, 6.7, 8.6; `ux.md` A1, A2, S1; slice 5): the real guards,
// controllers and use cases, with identity's database ports and the mail transport as in-memory
// fakes. nestjs-pino captures the log lines of a file's first application only, so the logging
// test comes first.

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Owner@Example.com';
const NAME = 'Amina Rahman';
const fakes = new IdentityFakes();

/** Market numbers of config/markets/AU.json and test/fixtures/markets/ZZ.json. */
const NUMBERS: Record<string, { state: string; keptSeconds: number }> = {
  AU: { state: 'pending', keptSeconds: 43_200 * 60 },
  ZZ: { state: 'approved', keptSeconds: 20_160 * 60 },
};

const cookieOf = (setCookie: unknown): string => {
  const [line] = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return line!.split(';', 1)[0]!;
};

describe('seller accounts over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());
  const post = (
    path: string,
    market: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    http()
      .post(`/identity/seller/${path}`)
      .set({ 'x-market-id': market, ...headers })
      .send(body as object);

  async function boot() {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      override: (builder) => fakes.override(builder),
    }));
  }

  const systemOf = (code: string) =>
    testCallContext(testMarketContext(code, PLATFORM_TENANT_ID), 'system', 'seller-e2e-0001');

  async function seedRoles(code: string) {
    await app.get(SeedSystemRoles).execute(systemOf(code), {});
  }

  /** Runs the link-mail handler for the latest link request; answers the mailed token. */
  async function mailedToken(code: string): Promise<string> {
    const event = fakes.events
      .filter((e) => e.type === 'identity.one-time-link-requested.v1')
      .at(-1)!;
    const payload = event.payload as { linkId: Id; accountId: Id };
    await app.get(SendLinkMail).execute(systemOf(code), {
      delivery: {
        eventId:
          `0199dddd-0000-7000-8000-${String(fakes.mails.length + 1).padStart(12, '0')}` as Id<'event'>,
        subscriber: 'identity.link-mail',
        attempt: 1,
      },
      linkId: payload.linkId,
      accountId: payload.accountId,
      purpose: 'verify-email',
      aggregateVersion: event.aggregateVersion,
    });
    return /#(ml1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
  }

  /** Signs up and confirms; answers the confirmation response. */
  async function signUpAndConfirm(code: string) {
    await seedRoles(code);
    const signedUp = await post('sign-up', code, {
      displayName: NAME,
      email: EMAIL,
      password: PASSWORD,
    });
    expect(signedUp.status).toBe(202);
    const token = await mailedToken(code);
    return post('confirm-email', code, { token, password: PASSWORD });
  }

  beforeEach(() => fakes.reset());
  afterEach(async () => {
    await app.close();
  });

  it('logs outcomes with the correlation id, never the email, the name, the password or the token', async () => {
    await boot();

    const confirmed = await signUpAndConfirm('AU');
    const signedIn = await post('sign-in', 'AU', { email: EMAIL, password: PASSWORD });

    expect([confirmed.status, signedIn.status]).toEqual([200, 200]);
    expect(logLines.find((l) => l.msg === 'identity.seller-sign-up')).toMatchObject({
      outcome: 'sign-up.accepted',
      marketId: 'AU',
    });
    expect(logLines.find((l) => l.msg === 'identity.seller-sign-in')).toMatchObject({
      outcome: 'signed-in',
      marketId: 'AU',
      correlationId: signedIn.headers['x-correlation-id'] as string,
    });
    const all = JSON.stringify(logLines);
    expect(all).not.toContain(EMAIL.toLowerCase());
    expect(all).not.toContain(NAME);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(cookieOf(signedIn.headers['set-cookie']).split('=')[1]);
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const name = `__Host-session-seller-${code}`;

    it('answers access.unavailable (503) to a sign-up before the system roles exist', async () => {
      await boot();

      const response = await post('sign-up', code, {
        displayName: NAME,
        email: EMAIL,
        password: PASSWORD,
      });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ statusCode: 503, code: 'access.unavailable' });
    });

    it('signs up, confirms into a browser-session cookie, reads the session and status, signs out', async () => {
      await boot();

      const confirmed = await signUpAndConfirm(code);

      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toEqual({
        code: 'signed-in',
        csrfToken: expect.any(String) as unknown,
        sellerAccess: NUMBERS[code]!.state,
      });
      const [setCookie] = confirmed.headers['set-cookie'] as unknown as string[];
      // No Max-Age: the default seller session ends with the browser (6.1).
      expect(setCookie).toMatch(
        new RegExp(`^${name}=ms1_[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax$`),
      );
      const cookie = cookieOf(setCookie);
      const csrfToken = (confirmed.body as { csrfToken: string }).csrfToken;
      const [seller] = [...fakes.sellerAccess.values()];
      const [role] = [...fakes.roles.values()].filter((r) => r.scope === 'seller');

      const session = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie });
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({
        population: 'seller',
        sellerId: seller!.sellerId,
        roleId: role!.id,
        sellerAccessState: NUMBERS[code]!.state,
        email: EMAIL,
        displayName: NAME,
        permissionKeys: [],
        csrfToken,
      });

      const status = await http()
        .get('/identity/seller/status')
        .set({ 'x-market-id': code, cookie });
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({
        sellerId: seller!.sellerId,
        state: NUMBERS[code]!.state,
        reason: null,
      });
      expect(status.headers['cache-control']).toBe('no-store');

      const withoutToken = await post('sign-out', code, {}, { cookie });
      expect(withoutToken.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      const signedOut = await post('sign-out', code, {}, { cookie, 'x-csrf-token': csrfToken });
      expect(signedOut.status).toBe(200);
      const after = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie });
      expect(after.body).toEqual({ statusCode: 401, code: 'session.invalid' });
    });

    it('"keep me signed in" sets Max-Age to the kept absolute lifetime; a non-boolean is refused', async () => {
      await boot();
      await signUpAndConfirm(code);

      const kept = await post('sign-in', code, {
        email: EMAIL,
        password: PASSWORD,
        keepSignedIn: true,
      });
      const malformed = await post('sign-in', code, {
        email: EMAIL,
        password: PASSWORD,
        keepSignedIn: 'yes',
      });

      expect(kept.status).toBe(200);
      expect((kept.headers['set-cookie'] as unknown as string[])[0]).toMatch(
        new RegExp(`^${name}=ms1_[A-Za-z0-9_-]{43}; Max-Age=${NUMBERS[code]!.keptSeconds}; `),
      );
      expect(malformed.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'keepSignedIn', code: 'type' }] },
      });
    });

    it('a suspended seller: sign-in answers 403 seller-access.suspended and its session stops', async () => {
      await boot();
      const confirmed = await signUpAndConfirm(code);
      const cookie = cookieOf(confirmed.headers['set-cookie']);
      const [seller] = [...fakes.sellerAccess.values()];
      fakes.seedSellerAccess({ ...seller!, state: 'suspended' });

      const signIn = await post('sign-in', code, { email: EMAIL, password: PASSWORD });
      const session = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie });

      expect(signIn.body).toEqual({ statusCode: 403, code: 'seller-access.suspended' });
      expect(session.body).toEqual({ statusCode: 401, code: 'session.invalid' });
    });

    it('answers membership.none (403) after the password, credentials.invalid (401) before', async () => {
      await boot();
      await signUpAndConfirm(code);
      fakes.memberships.clear();

      const wrong = await post('sign-in', code, { email: EMAIL, password: `${PASSWORD}!` });
      const right = await post('sign-in', code, { email: EMAIL, password: PASSWORD });

      expect(wrong.body).toEqual({ statusCode: 401, code: 'credentials.invalid' });
      expect(right.body).toEqual({ statusCode: 403, code: 'membership.none' });
    });

    it('a seller cookie does not open the customer session, nor a customer cookie the seller one', async () => {
      await boot();
      const confirmed = await signUpAndConfirm(code);
      const sellerCookie = cookieOf(confirmed.headers['set-cookie']);
      const value = sellerCookie.split('=')[1]!;

      const customer = await http()
        .get('/identity/customer/session')
        .set({ 'x-market-id': code, cookie: sellerCookie });
      const renamed = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie: `__Host-session-customer-${code}=${value}` });

      expect(customer.status).toBe(401);
      expect(renamed.status).toBe(401);
    });

    it('"send it again" answers 202 with one body for a known and an unknown address', async () => {
      await boot();
      await seedRoles(code);
      await post('sign-up', code, { displayName: NAME, email: EMAIL, password: PASSWORD });

      const known = await post('verification-email', code, { email: EMAIL });
      const unknown = await post('verification-email', code, { email: 'nobody@example.com' });

      expect([known.status, unknown.status]).toEqual([202, 202]);
      expect(unknown.body).toEqual(known.body);
    });
  });
});
