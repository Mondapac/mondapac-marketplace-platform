import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { RandomLinkTokens } from '../src/modules/identity/infrastructure/links/random-link-tokens';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { realPermissionRegistry } from './support/permission-registry';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

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
const NUMBERS: Record<
  string,
  { state: string; keptSeconds: number; limit: number; blockSeconds: number; mailLimit: number }
> = {
  AU: { state: 'pending', keptSeconds: 43_200 * 60, limit: 5, blockSeconds: 15 * 60, mailLimit: 3 },
  ZZ: {
    state: 'approved',
    keptSeconds: 20_160 * 60,
    limit: 4,
    blockSeconds: 20 * 60,
    mailLimit: 2,
  },
};

const linkTokens = new RandomLinkTokens();

/** An unverified customer account with an issued `verify-email` link; answers the token. */
function seedUnverifiedCustomer(code: string): string {
  const now = Temporal.Now.instant();
  const created = now.subtract({ hours: 1 });
  const accountId =
    `0199${code === 'AU' ? 'cccc' : 'dddd'}-0000-7000-8000-000000000001` as Id<'Account'>;
  const account: AccountState = {
    id: accountId,
    marketId: code as AccountState['marketId'],
    population: 'customer',
    email: { typed: EMAIL, normalized: EMAIL.toLowerCase() },
    displayName: null,
    status: 'active',
    emailVerifiedAt: null,
    existingAccountNoticeAt: null,
    signedUpAt: created,
    createdAt: created,
    version: 1,
    credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: created },
  };
  fakes.seedAccount(account);
  const { token, tokenHash } = linkTokens.issue();
  const linkId = `0199${code === 'AU' ? 'cccc' : 'dddd'}-0000-7000-8000-0000000000a1`;
  fakes.links.set(linkId, {
    id: linkId as Id<'OneTimeLink'>,
    marketId: account.marketId,
    accountId,
    purpose: 'verify-email',
    requestedAt: created,
    tokenHash,
    issuedAt: created,
    expiresAt: now.add({ hours: 1 }),
    consumedAt: null,
    version: 2,
  });
  return token;
}

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
      .set({ 'x-market-id': market, ...panelHeaders(market, 'seller'), ...headers })
      .send(body as object);

  async function boot() {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      // Seller routes need the seller panel's origin on the list (identity design 6.4).
      panelOrigins: true,
      override: (builder) => fakes.override(builder),
    }));
  }

  const systemOf = (code: string) =>
    testCallContext(testMarketContext(code, PLATFORM_TENANT_ID), 'system', 'seller-e2e-0001');

  async function seedRoles(code: string) {
    await app.get(SeedRoles).execute(systemOf(code), {});
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
      const [role] = [...fakes.roles.values()].filter(
        (r) => r.scope === 'seller' && r.kind === 'system',
      );

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
        // The Seller Owner holds every seller key of the registry, sorted (slice 8a-1). The
        // summary is a hint: while the seller is pending, the gate still refuses what is not on
        // the allow-list.
        permissionKeys: realPermissionRegistry()
          .list('seller')
          .map((d) => d.key),
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

    it('answers credentials.invalid, then request.throttled (429) with Retry-After at the limit', async () => {
      await boot();
      await signUpAndConfirm(code);
      const { limit, blockSeconds } = NUMBERS[code]!;

      for (let n = 0; n < limit; n += 1) {
        const failed = await post('sign-in', code, { email: EMAIL, password: 'wrong password' });
        expect(failed.body).toEqual({ statusCode: 401, code: 'credentials.invalid' });
      }
      const throttled = await post('sign-in', code, { email: EMAIL, password: PASSWORD });

      expect(throttled.status).toBe(429);
      expect(throttled.body).toMatchObject({ code: 'request.throttled' });
      const retryAfter = Number(throttled.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(blockSeconds);
      expect(throttled.headers['set-cookie']).toBeUndefined();
    });

    it("refuses a customer's verify-email token on the seller confirmation (link.rejected)", async () => {
      await boot();
      const token = seedUnverifiedCustomer(code);

      const response = await post('confirm-email', code, { token, password: PASSWORD });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ statusCode: 400, code: 'link.rejected' });
      expect([...fakes.accounts.values()][0]!.emailVerifiedAt).toBeNull();
    });

    it("refuses a seller's verify-email token on the customer confirmation, and it still works for the seller", async () => {
      await boot();
      await seedRoles(code);
      await post('sign-up', code, { displayName: NAME, email: EMAIL, password: PASSWORD });
      const token = await mailedToken(code);

      const customer = await http()
        .post('/identity/customer/confirm-email')
        .set({ 'x-market-id': code })
        .send({ token, password: PASSWORD });
      const seller = await post('confirm-email', code, { token, password: PASSWORD });

      expect(customer.status).toBe(400);
      expect(customer.body).toEqual({ statusCode: 400, code: 'link.rejected' });
      expect(seller.status).toBe(200);
    });

    describe('sign-up answers one body whatever the address (AC 21, Sajad gap 2)', () => {
      const ACCEPTED = { code: 'sign-up.accepted' };
      const signUp = (email: string) =>
        post('sign-up', code, { displayName: NAME, email, password: PASSWORD });

      it('a new address and the address of a verified seller', async () => {
        await boot();
        await seedRoles(code);
        const fresh = await signUp('new.seller@example.com');
        await signUpAndConfirm(code);

        const verified = await signUp(EMAIL);

        expect([fresh.status, verified.status]).toEqual([202, 202]);
        expect(fresh.body).toEqual(ACCEPTED);
        expect(verified.body).toEqual(fresh.body);
        expect(verified.headers['set-cookie']).toBeUndefined();
      });

      it('the address of a disabled account', async () => {
        await boot();
        await seedRoles(code);
        const fresh = await signUp('new.seller@example.com');
        await signUp(EMAIL);
        const owner = [...fakes.accounts.values()].find(
          (a) => a.email.normalized === EMAIL.toLowerCase(),
        )!;
        fakes.seedAccount({ ...owner, status: 'disabled' });

        const disabled = await signUp(EMAIL);

        expect(disabled.status).toBe(202);
        expect(disabled.body).toEqual(fresh.body);
      });

      it('a sign-up over the mail limit of its address', async () => {
        await boot();
        await seedRoles(code);
        const fresh = await signUp('new.seller@example.com');
        const { mailLimit } = NUMBERS[code]!;
        for (let n = 0; n < mailLimit; n += 1) await signUp(EMAIL);
        const linkEvents = () =>
          fakes.events.filter(
            (e) =>
              e.type === 'identity.one-time-link-requested.v1' &&
              e.payload['accountId'] !== fakes.events[0]!.payload['accountId'],
          ).length;
        expect(linkEvents()).toBe(mailLimit);

        const throttled = await signUp(EMAIL);

        expect(throttled.status).toBe(202);
        expect(throttled.body).toEqual(fresh.body);
        // The mail was refused: no new link request was published.
        expect(linkEvents()).toBe(mailLimit);
      });
    });
  });
});
