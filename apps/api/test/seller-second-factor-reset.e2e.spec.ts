import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  IDENTITY_MARKET_POLICY,
  type IdentityMarketPolicy,
} from '../src/modules/identity/application/ports/identity-market-policy';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { decodeBase32Secret } from '../src/modules/identity/domain/otpauth';
import { openSession } from '../src/modules/identity/domain/session';
import { TOTP } from '../src/modules/identity/domain/totp';
import { MarketConfigIdentityPolicy } from '../src/modules/identity/infrastructure/market-config-identity-policy';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { hotp } from '../src/modules/identity/infrastructure/second-factor/totp';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { MarketRegistry } from '../src/platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The owner-confirmed reset of a Seller Owner's second factor over HTTP (identity design 3.7,
// 7.3; `ux.md` E15, A11, F7 step 4; slice 12): an admin starts it, the owner is mailed a link and
// confirms it anonymously, and only then is the factor removed. The real guards, controllers and
// use cases, with identity's database ports and the mail transport as in-memory fakes.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const STEP = Temporal.Duration.from({ seconds: TOTP.periodSeconds });
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Owner@Example.com';
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const ADMIN = id<'Account'>(`01990000-0000-7000-8000-${n12(0xa001)}`);
const VIEWER = id<'Account'>(`01990000-0000-7000-8000-${n12(0xa002)}`);
const MISSING = '01990000-0000-7000-8000-00000000ffff';

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;
let deliveries = 0;

const cookieOf = (setCookie: unknown): string => {
  const [line] = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return line!.split(';', 1)[0]!;
};

describe('owner-confirmed reset of a seller second factor over HTTP (integration, slice 12)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());

  async function boot(options: { readonly withoutResetLifetime?: boolean } = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) => {
        const built = fakes.override(builder).overrideProvider(CLOCK).useValue(clock);
        return options.withoutResetLifetime === true
          ? built
              .overrideProvider(IDENTITY_MARKET_POLICY)
              .useFactory({ factory: withoutResetLifetime, inject: [MarketRegistry] })
          : built;
      },
    }));
  }

  /** The real policy of a Market that configures no lifetime for the owner's confirmation link. */
  function withoutResetLifetime(markets: MarketRegistry): IdentityMarketPolicy {
    const base = new MarketConfigIdentityPolicy(markets);
    return Object.assign(Object.create(base) as IdentityMarketPolicy, {
      linkLifetimeMinutes: (
        market: Parameters<IdentityMarketPolicy['linkLifetimeMinutes']>[0],
        purpose: Parameters<IdentityMarketPolicy['linkLifetimeMinutes']>[1],
      ) =>
        purpose === 'confirm-second-factor-reset'
          ? null
          : base.linkLifetimeMinutes(market, purpose),
    });
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const systemOf = (code: string) => testCallContext(marketOf(code), 'system', 'seller-reset-0001');
  const roleOf = (seedCode: string) =>
    [...fakes.roles.values()].find((r) => r.scope === 'platform' && r.seedCode === seedCode)!.id;

  const sellerPost = (code: string, path: string, body: unknown, headers = {}) =>
    http()
      .post(`/identity/seller/${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers })
      .send(body as object);
  const adminPost = (code: string, path: string, body: unknown, headers: Record<string, string>) =>
    http()
      .post(`/identity/admin/${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers })
      .send(body as object);

  const codeFor = (secret: string, at: Temporal.Instant = clock.now()) =>
    hotp(decodeBase32Secret(secret)!, Math.floor(at.epochMilliseconds / 1000 / TOTP.periodSeconds));

  /** Runs the link mail of the latest request for `purpose`; answers the token it carried. */
  async function mailedLink(code: string, purpose: string): Promise<string> {
    const event = fakes.events
      .filter(
        (e) =>
          e.type === 'identity.one-time-link-requested.v1' &&
          (e.payload as { purpose: string }).purpose === purpose,
      )
      .at(-1)!;
    const payload = event.payload as { linkId: Id; accountId: Id };
    const sent = await app.get(SendLinkMail).execute(systemOf(code), {
      delivery: {
        eventId: `0199dddd-0000-7000-8000-${n12(++deliveries)}` as Id<'event'>,
        subscriber: 'identity.link-mail',
        attempt: 1,
      },
      linkId: payload.linkId,
      accountId: payload.accountId,
      purpose: purpose as 'verify-email',
      aggregateVersion: event.aggregateVersion,
    });
    expect(sent).toMatchObject({ ok: true, value: { code: 'link-mail.sent' } });
    return /#(ml1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
  }

  /** Seeds the roles and two admins: a Platform Administrator and a Viewer (no reset key). */
  async function seededAdmins(code: string) {
    await app.get(SeedRoles).execute(systemOf(code), {});
    const marketId = code as AccountState['marketId'];
    const admin = (n: number, accountId: Id<'Account'>, seedCode: string) => {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'admin',
        email: { typed: `admin${n}@example.com`, normalized: `admin${n}@example.com` },
        displayName: `Admin ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId,
        roleId: roleOf(seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ADMIN, 'platform-administrator');
    admin(2, VIEWER, 'viewer');
  }

  function adminSession(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf100 + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  /** A seller owner, signed up, approved and enrolled; answers its sellerId and its session. */
  async function ownerWithFactor(code: string) {
    const signedUp = await sellerPost(code, 'sign-up', {
      displayName: 'Amina Rahman',
      email: EMAIL,
      password: PASSWORD,
    });
    expect(signedUp.status).toBe(202);
    const verifyToken = await mailedLink(code, 'verify-email');
    const confirmed = await sellerPost(code, 'confirm-email', {
      token: verifyToken,
      password: PASSWORD,
    });
    expect(confirmed.status).toBe(200);
    const [seller] = [...fakes.sellerAccess.values()];
    fakes.seedSellerAccess({ ...seller!, state: 'approved' });
    const session = {
      cookie: cookieOf(confirmed.headers['set-cookie']),
      'x-csrf-token': (confirmed.body as { csrfToken: string }).csrfToken,
    };
    const started = await sellerPost(
      code,
      'second-factor/enrolment',
      { password: PASSWORD },
      session,
    );
    const enrol = started.body as { challengeToken: string; secret: string };
    clock.advance(STEP);
    const done = await sellerPost(code, 'second-factor/enrolment/confirm', {
      challengeToken: enrol.challengeToken,
      code: codeFor(enrol.secret),
    });
    expect(done.status).toBe(200);
    // Enrolment ends every session; the owner signs in again with both steps.
    clock.advance(STEP);
    const step = await sellerPost(code, 'sign-in', { email: EMAIL, password: PASSWORD });
    clock.advance(STEP);
    const signedIn = await sellerPost(code, 'sign-in/second-factor', {
      challengeToken: (step.body as { challengeToken: string }).challengeToken,
      code: codeFor(enrol.secret),
    });
    expect(signedIn.status).toBe(200);
    return {
      sellerId: seller!.sellerId,
      cookie: cookieOf(signedIn.headers['set-cookie']),
    };
  }

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    deliveries = 0;
  });
  afterEach(async () => {
    await app.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('starts the reset, mails E15 and removes the factor only when the owner confirms', async () => {
      await boot();
      await seededAdmins(code);
      const owner = await ownerWithFactor(code);
      const admin = adminSession(code, ADMIN, 1);
      const mailsBefore = fakes.mails.length;

      const started = await adminPost(
        code,
        `sellers/${owner.sellerId}/second-factor/reset`,
        {},
        admin,
      );
      expect(started.status).toBe(200);
      expect(started.body).toEqual({
        code: 'second-factor-reset.requested',
        sellerId: owner.sellerId,
      });
      // Nothing is removed and no session ends until the owner confirms.
      expect(fakes.factors.size).toBe(1);
      expect(fakes.mails.length).toBe(mailsBefore);
      expect(
        fakes.audits.filter((a) => a.action === 'identity.seller-second-factor-reset.requested'),
      ).toHaveLength(1);

      const token = await mailedLink(code, 'confirm-second-factor-reset');
      const mail = fakes.mails.at(-1)!;
      expect(mail.to).toBe(EMAIL);
      expect(mail.text).toContain('seller');
      expect(fakes.factors.size).toBe(1);
      const stillIn = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie: owner.cookie });
      expect(stillIn.status).toBe(200);

      // Inside the shortest lifetime of the two Markets (ZZ: 12 hours).
      clock.advance(Temporal.Duration.from({ hours: 11 }));
      const confirmed = await sellerPost(code, 'second-factor/reset/confirm', { token });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toEqual({ code: 'second-factor.reset' });
      expect(confirmed.headers['cache-control']).toBe('no-store');
      expect(confirmed.headers['set-cookie']).toBeUndefined();
      expect(fakes.factors.size).toBe(0);
      expect(
        fakes.events.filter((e) => e.type === 'identity.second-factor-changed.v1').at(-1)!.payload,
      ).toMatchObject({ change: 'reset' });
      expect(
        fakes.audits.filter((a) => a.action === 'identity.seller-second-factor-reset.confirmed'),
      ).toHaveLength(1);
      const ended = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie: owner.cookie });
      expect(ended.body).toEqual({ statusCode: 401, code: 'session.invalid' });

      // The owner signs in with the password alone from now on.
      const signIn = await sellerPost(code, 'sign-in', { email: EMAIL, password: PASSWORD });
      expect(signIn.body).toMatchObject({ code: 'signed-in' });

      const all = JSON.stringify(logLines);
      expect(all).not.toContain(token);
      expect(all).not.toContain(EMAIL.toLowerCase());
    });

    it('answers link.rejected for a link used twice', async () => {
      await boot();
      await seededAdmins(code);
      const owner = await ownerWithFactor(code);
      await adminPost(
        code,
        `sellers/${owner.sellerId}/second-factor/reset`,
        {},
        adminSession(code, ADMIN, 1),
      );
      const token = await mailedLink(code, 'confirm-second-factor-reset');

      expect((await sellerPost(code, 'second-factor/reset/confirm', { token })).status).toBe(200);
      const again = await sellerPost(code, 'second-factor/reset/confirm', { token });
      expect([again.status, again.body]).toEqual([400, { statusCode: 400, code: 'link.rejected' }]);
    });

    it('answers link.rejected for an expired link and leaves the factor', async () => {
      await boot();
      await seededAdmins(code);
      const owner = await ownerWithFactor(code);
      await adminPost(
        code,
        `sellers/${owner.sellerId}/second-factor/reset`,
        {},
        adminSession(code, ADMIN, 1),
      );
      const token = await mailedLink(code, 'confirm-second-factor-reset');

      // AU: 24 hours; ZZ: 12 hours (the Market's own lifetime).
      clock.advance(Temporal.Duration.from({ hours: 25 }));
      const expired = await sellerPost(code, 'second-factor/reset/confirm', { token });
      expect([expired.status, expired.body]).toEqual([
        400,
        { statusCode: 400, code: 'link.rejected' },
      ]);
      expect(fakes.factors.size).toBe(1);
    });

    it('a second start replaces the first link', async () => {
      await boot();
      await seededAdmins(code);
      const owner = await ownerWithFactor(code);
      const admin = adminSession(code, ADMIN, 1);
      await adminPost(code, `sellers/${owner.sellerId}/second-factor/reset`, {}, admin);
      const first = await mailedLink(code, 'confirm-second-factor-reset');
      // Past the mail counter's window, so the second request is counted afresh.
      clock.advance(Temporal.Duration.from({ minutes: 61 }));
      const later = adminSession(code, ADMIN, 3);
      const again = await adminPost(
        code,
        `sellers/${owner.sellerId}/second-factor/reset`,
        {},
        later,
      );
      expect(again.status).toBe(200);
      const second = await mailedLink(code, 'confirm-second-factor-reset');

      const old = await sellerPost(code, 'second-factor/reset/confirm', { token: first });
      expect(old.status).toBe(400);
      expect(fakes.factors.size).toBe(1);
      const current = await sellerPost(code, 'second-factor/reset/confirm', { token: second });
      expect(current.status).toBe(200);
    });

    it('counts the mail on the owner address: starting again and again is throttled', async () => {
      await boot();
      await seededAdmins(code);
      const owner = await ownerWithFactor(code);
      const admin = adminSession(code, ADMIN, 1);
      const path = `sellers/${owner.sellerId}/second-factor/reset`;

      const answers = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        answers.push(await adminPost(code, path, {}, admin));
      }
      const throttled = answers.find((answer) => answer.status === 429)!;
      expect(throttled.body).toMatchObject({ code: 'request.throttled' });
      expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
      expect(answers[0]!.status).toBe(200);
    });

    it('refuses a confirmation of an account that is no longer the Seller Owner', async () => {
      await boot();
      await seededAdmins(code);
      const owner = await ownerWithFactor(code);
      await adminPost(
        code,
        `sellers/${owner.sellerId}/second-factor/reset`,
        {},
        adminSession(code, ADMIN, 1),
      );
      const token = await mailedLink(code, 'confirm-second-factor-reset');
      // The account lost its owner role since the mail went.
      fakes.assignments.clear();

      const refused = await sellerPost(code, 'second-factor/reset/confirm', { token });
      expect([refused.status, refused.body]).toEqual([
        400,
        { statusCode: 400, code: 'link.rejected' },
      ]);
      expect(fakes.factors.size).toBe(1);
    });

    it('answers the same link.rejected for a malformed, unknown or other-purpose token', async () => {
      await boot();
      await seededAdmins(code);
      await ownerWithFactor(code);
      // The verification link of the same account is of another purpose.
      const other = await sellerPost(code, 'second-factor/reset/confirm', {
        token: 'ml1_' + 'A'.repeat(43),
      });
      const malformed = await sellerPost(code, 'second-factor/reset/confirm', { token: 'nope' });
      const missing = await sellerPost(code, 'second-factor/reset/confirm', {});
      expect([other.body, malformed.body]).toEqual([
        { statusCode: 400, code: 'link.rejected' },
        { statusCode: 400, code: 'link.rejected' },
      ]);
      expect(missing.status).toBe(400);
      expect(missing.body).toMatchObject({ code: 'validation.failed' });
      expect(fakes.factors.size).toBe(1);
    });

    it('refuses a token minted in another Market', async () => {
      await boot();
      await seededAdmins(code);
      const owner = await ownerWithFactor(code);
      await adminPost(
        code,
        `sellers/${owner.sellerId}/second-factor/reset`,
        {},
        adminSession(code, ADMIN, 1),
      );
      const token = await mailedLink(code, 'confirm-second-factor-reset');
      const otherMarket = TEST_MARKETS.find((m) => m !== code)!;

      const wrong = await sellerPost(otherMarket, 'second-factor/reset/confirm', { token });
      expect([wrong.status, wrong.body]).toEqual([400, { statusCode: 400, code: 'link.rejected' }]);
      expect(fakes.factors.size).toBe(1);
    });

    it('refuses an admin without the permission, a missing session and a missing CSRF token', async () => {
      await boot();
      await seededAdmins(code);
      const owner = await ownerWithFactor(code);
      const path = `sellers/${owner.sellerId}/second-factor/reset`;
      const viewer = adminSession(code, VIEWER, 2);

      const denied = await adminPost(code, path, {}, viewer);
      expect([denied.status, denied.body]).toEqual([
        403,
        { statusCode: 403, code: 'access.denied' },
      ]);
      const anonymous = await adminPost(code, path, {}, {});
      expect(anonymous.status).toBe(401);
      const noCsrf = await adminPost(code, path, {}, { cookie: viewer.cookie });
      expect([noCsrf.status, noCsrf.body]).toEqual([
        403,
        { statusCode: 403, code: 'request.csrf' },
      ]);
      // A seller's own session never starts it.
      const seller = await adminPost(code, path, {}, { cookie: owner.cookie });
      expect(seller.status).toBe(401);
      expect(
        fakes.events.filter(
          (e) => (e.payload as { purpose?: string }).purpose === 'confirm-second-factor-reset',
        ),
      ).toEqual([]);
    });

    it('answers 404 for an unknown or malformed seller and 409 when the owner has no factor', async () => {
      await boot();
      await seededAdmins(code);
      const admin = adminSession(code, ADMIN, 1);
      const unknown = await adminPost(code, `sellers/${MISSING}/second-factor/reset`, {}, admin);
      const malformed = await adminPost(code, 'sellers/not-an-id/second-factor/reset', {}, admin);
      for (const answer of [unknown, malformed]) {
        expect([answer.status, answer.body]).toEqual([
          404,
          { statusCode: 404, code: 'seller.unknown' },
        ]);
      }
      const owner = await ownerWithFactor(code);
      fakes.factors.clear();
      const none = await adminPost(
        code,
        `sellers/${owner.sellerId}/second-factor/reset`,
        {},
        admin,
      );
      expect([none.status, none.body]).toEqual([
        409,
        { statusCode: 409, code: 'second-factor.none' },
      ]);
    });
  });

  it('fails closed when the Market configures no lifetime for the owner link', async () => {
    await boot({ withoutResetLifetime: true });
    await seededAdmins('AU');
    const owner = await ownerWithFactor('AU');
    const eventsBefore = fakes.events.length;

    const refused = await adminPost(
      'AU',
      `sellers/${owner.sellerId}/second-factor/reset`,
      {},
      adminSession('AU', ADMIN, 1),
    );
    expect([refused.status, refused.body]).toEqual([
      503,
      { statusCode: 503, code: 'access.unavailable' },
    ]);
    expect(fakes.events.length).toBe(eventsBefore);
    expect(fakes.factors.size).toBe(1);
  });
});
