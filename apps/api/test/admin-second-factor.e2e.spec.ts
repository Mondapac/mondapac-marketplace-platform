import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { AcceptAdminInvitation } from '../src/modules/identity/application/use-cases/accept-admin-invitation.use-case';
import { ChangePassword } from '../src/modules/identity/application/use-cases/change-password.use-case';
import { CompleteAdminSignIn } from '../src/modules/identity/application/use-cases/complete-admin-sign-in.use-case';
import { CompleteSecondFactorReplacement } from '../src/modules/identity/application/use-cases/complete-second-factor-replacement.use-case';
import { ConfirmSecondFactorEnrolment } from '../src/modules/identity/application/use-cases/confirm-second-factor-enrolment.use-case';
import { IssueFirstAdminInvitation } from '../src/modules/identity/application/use-cases/issue-first-admin-invitation.use-case';
import { RequestPasswordReset } from '../src/modules/identity/application/use-cases/request-password-reset.use-case';
import { ResetPassword } from '../src/modules/identity/application/use-cases/reset-password.use-case';
import { PurgeExpired } from '../src/modules/identity/application/use-cases/purge-expired.use-case';
import { RegenerateRecoveryCodes } from '../src/modules/identity/application/use-cases/regenerate-recovery-codes.use-case';
import { ResetAdminSecondFactor } from '../src/modules/identity/application/use-cases/reset-admin-second-factor.use-case';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendInvitationMail } from '../src/modules/identity/application/use-cases/send-invitation-mail.use-case';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import { SendSecondFactorMail } from '../src/modules/identity/application/use-cases/send-second-factor-mail.use-case';
import { SignInAdmin } from '../src/modules/identity/application/use-cases/sign-in-admin.use-case';
import { StartAdminInvitationAcceptance } from '../src/modules/identity/application/use-cases/start-admin-invitation-acceptance.use-case';
import { StartSecondFactorEnrolment } from '../src/modules/identity/application/use-cases/start-second-factor-enrolment.use-case';
import { StartSecondFactorReplacement } from '../src/modules/identity/application/use-cases/start-second-factor-replacement.use-case';
import { decodeBase32Secret } from '../src/modules/identity/domain/otpauth';
import { TOTP } from '../src/modules/identity/domain/totp';
import { hotp } from '../src/modules/identity/infrastructure/second-factor/totp';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import {
  IDENTITY_MARKET_POLICY,
  type IdentityMarketPolicy,
} from '../src/modules/identity/application/ports/identity-market-policy';
import { MarketConfigIdentityPolicy } from '../src/modules/identity/infrastructure/market-config-identity-policy';
import { loadMarketConfigs } from '../src/platform/market-config/market-config';
import { MarketRegistry } from '../src/platform/market-config/market-registry';
import {
  panelHeaders,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
  testMarketId,
} from './support/test-config';

// Admin sign-in with its second factor, the first-admin invitation, enrolment, devices and the
// break-glass reset (identity design 3.4 to 3.7, 6.1 to 6.8, 7.2 to 7.4; slice 7b items A to I
// and Hassan I-1 to I-7): the real guards, controllers and use cases, with identity's database
// ports and the mail transport as in-memory fakes and a fixed clock. The admin values are AU's
// and ZZ's own Market configuration. The anonymous HTTP limit of ZZ is 10 a minute, so each case sends
// only the requests it is about over HTTP and prepares the rest through the use cases.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const EMAIL = 'Root.Admin@Example.com';
const NAME = 'Maryam Haddad';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a different long passphrase';
const CLIENT = { origin: '203.0.113.7', address: '203.0.113.7' };
const STEP = Temporal.Duration.from({ seconds: TOTP.periodSeconds });

const MARKETS = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

/** The slice 7b values of a Market, as config/markets/AU.json or the ZZ fixture holds them. */
function adminConfigOf(code: string) {
  const identity = MARKETS.get(testMarketId(code))!.identity;
  const pages = identity.links.targets.admin!;
  return {
    pages: {
      'accept-invitation': pages['accept-invitation']!,
      'enrol-second-factor': pages['enrol-second-factor']!,
    },
    adminSession: { idleTimeoutSeconds: identity.sessions.admin!.idleTimeoutMinutes * 60 },
    secondFactorThrottle: identity.secondFactorThrottles!.account,
    challengeLifetimeSeconds: identity.challenges!.lifetimeSeconds,
    invitationMinutes: {
      admin: identity.invitations!.lifetimeMinutes.admin!,
      'seller-owner': identity.invitations!.lifetimeMinutes['seller-owner']!,
      staff: identity.invitations!.lifetimeMinutes.staff!,
    },
  };
}

const fakes = new IdentityFakes();
let clock: FixedClock;
let deliveries = 0;

const cookieOf = (setCookie: unknown): string => {
  const [line] = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return line!;
};

describe('admin second factor and invitations over HTTP (integration, slice 7b)', () => {
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
      .post(`/identity/admin/${path}`)
      .set({ 'x-market-id': market, ...panelHeaders(market, 'admin'), ...headers })
      .send(body as object);

  async function boot(options: { readonly withoutAdminKeys?: boolean } = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      // Admin routes need the admin panel's origin on the list (identity design 6.4).
      panelOrigins: true,
      override: (builder) => {
        const built = fakes.override(builder).overrideProvider(CLOCK).useValue(clock);
        return options.withoutAdminKeys === true
          ? built
              .overrideProvider(IDENTITY_MARKET_POLICY)
              .useFactory({ factory: withoutAdminKeys, inject: [MarketRegistry] })
          : built;
      },
    }));
  }

  /**
   * The real policy of a Market whose configuration holds none of the slice 7b keys, as a
   * Market that offers no admin sign-in: every admin read answers null.
   */
  function withoutAdminKeys(markets: MarketRegistry): IdentityMarketPolicy {
    const base = new MarketConfigIdentityPolicy(markets);
    return Object.assign(Object.create(base) as IdentityMarketPolicy, {
      sessionLifetime: (m: never, population: never, keep?: boolean) =>
        population === 'admin' ? null : base.sessionLifetime(m, population, keep),
      invitationLifetimeMinutes: () => null,
      challengePolicy: () => null,
      secondFactorThrottle: () => null,
    });
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const systemOf = (code: string) => testCallContext(marketOf(code), 'system', 'admin-e2e-0001');
  const anonymousOf = (code: string) =>
    testCallContext(marketOf(code), 'anonymous', 'admin-e2e-0002');
  const delivery = (subscriber: string) => ({
    eventId: `0199eeee-0000-7000-8000-${String(++deliveries).padStart(12, '0')}` as Id<'event'>,
    subscriber,
    attempt: 1,
  });

  /** The code the authenticator app shows now. */
  const codeFor = (secret: string, at: Temporal.Instant = clock.now()) =>
    hotp(decodeBase32Secret(secret)!, Math.floor(at.epochMilliseconds / 1000 / TOTP.periodSeconds));

  const eventsOf = (type: string) => fakes.events.filter((event) => event.type === type);
  const adminAccount = () =>
    [...fakes.accounts.values()].find((account) => account.population === 'admin')!;

  /** Seeds the roles, issues the first-admin invitation and runs its mail; answers the token. */
  async function invited(code: string, email = EMAIL): Promise<string> {
    await app.get(SeedRoles).execute(systemOf(code), {});
    const issued = await app.get(IssueFirstAdminInvitation).execute(systemOf(code), { email });
    expect(issued).toMatchObject({ ok: true, value: { code: 'invitation.issued' } });
    const event = eventsOf('identity.invitation-issued.v1').at(-1)!;
    const sent = await app.get(SendInvitationMail).execute(systemOf(code), {
      delivery: delivery('identity.invitation-mail'),
      invitationId: (event.payload as { invitationId: Id }).invitationId,
      aggregateVersion: event.aggregateVersion,
    });
    expect(sent).toMatchObject({ ok: true, value: { code: 'invitation-mail.sent' } });
    return /#(mi1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
  }

  /** Accepts the invitation through the use cases; answers the app's secret and the codes. */
  async function acceptedAdmin(code: string) {
    const token = await invited(code);
    const ready = await app
      .get(StartAdminInvitationAcceptance)
      .execute(anonymousOf(code), { token, client: CLIENT });
    if (!ready.ok) throw new Error(`enrolment refused: ${ready.error.code}`);
    const accepted = await app.get(AcceptAdminInvitation).execute(anonymousOf(code), {
      token,
      displayName: NAME,
      password: PASSWORD,
      secret: ready.value.secret,
      tag: ready.value.tag,
      expiresAt: ready.value.expiresAt.toString(),
      code: codeFor(ready.value.secret),
      client: CLIENT,
    });
    if (!accepted.ok) throw new Error(`acceptance refused: ${accepted.error.code}`);
    return { secret: ready.value.secret, recoveryCodes: accepted.value.recoveryCodes };
  }

  /** The password step through the use case; answers the challenge token. */
  async function challenge(code: string, password = PASSWORD): Promise<string> {
    clock.advance(STEP);
    const step = await app
      .get(SignInAdmin)
      .execute(anonymousOf(code), { email: EMAIL, password, client: CLIENT });
    if (!step.ok || step.value.code !== 'second-factor-required') {
      throw new Error(`no challenge: ${JSON.stringify(step)}`);
    }
    return step.value.challengeToken;
  }

  /** Signs in through both steps; answers the session's actor context. */
  async function signedIn(code: string, secret: string) {
    const challengeToken = await challenge(code);
    const done = await app.get(CompleteAdminSignIn).execute(anonymousOf(code), {
      challengeToken,
      code: codeFor(secret),
      client: CLIENT,
    });
    if (!done.ok) throw new Error(`sign-in refused: ${done.error.code}`);
    const session = [...fakes.sessions.values()].at(-1)!.session;
    const account = adminAccount();
    const market = marketOf(code);
    return testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: account.id,
        sessionId: session.id,
        sellerId: null,
      }),
      'admin-e2e-0003',
    );
  }

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app.close();
  });

  it('logs outcomes with the correlation id, never the email, password, secret, code or token', async () => {
    await boot();
    const token = await invited('AU');

    const ready = await post('invitation/enrolment', 'AU', { token });
    const body = ready.body as { secret: string; tag: string; expiresAt: string };
    const appCode = codeFor(body.secret);
    const accepted = await post('invitation/accept', 'AU', {
      token,
      displayName: NAME,
      password: PASSWORD,
      secret: body.secret,
      tag: body.tag,
      expiresAt: body.expiresAt,
      code: appCode,
    });
    clock.advance(STEP);
    const step = await post('sign-in', 'AU', { email: EMAIL, password: PASSWORD });

    expect([ready.status, accepted.status, step.status]).toEqual([200, 200, 200]);
    expect(logLines.find((l) => l.msg === 'identity.admin-sign-in')).toMatchObject({
      outcome: 'second-factor-required',
      marketId: 'AU',
      correlationId: step.headers['x-correlation-id'] as string,
    });
    const all = JSON.stringify(logLines);
    for (const secret of [
      EMAIL.toLowerCase(),
      NAME,
      PASSWORD,
      token,
      body.secret,
      body.tag,
      (step.body as { challengeToken: string }).challengeToken,
      ...(accepted.body as { recoveryCodes: string[] }).recoveryCodes,
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const fixture = adminConfigOf(code);
    const cookieName = `__Host-session-admin-${code}`;

    it('accepts the first-admin invitation, then signs in with a code into a browser-session cookie', async () => {
      await boot();
      const token = await invited(code);
      expect(fakes.mails.at(-1)!.text).toContain(`${fixture.pages['accept-invitation']}#${token}`);

      const ready = await post('invitation/enrolment', code, { token });
      expect(ready.status).toBe(200);
      expect(ready.headers['cache-control']).toBe('no-store');
      const enrol = ready.body as {
        code: string;
        secret: string;
        otpauthUri: string;
        tag: string;
        expiresAt: string;
      };
      expect(enrol.code).toBe('invitation.enrolment-ready');
      expect(enrol.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      expect(Temporal.Instant.from(enrol.expiresAt).toString()).toBe(
        START.add({ minutes: 15 }).toString(),
      );
      // Nothing is stored before the acceptance.
      expect(fakes.factors.size).toBe(0);

      const accepted = await post('invitation/accept', code, {
        token,
        displayName: NAME,
        password: PASSWORD,
        secret: enrol.secret,
        tag: enrol.tag,
        expiresAt: enrol.expiresAt,
        code: codeFor(enrol.secret),
      });
      expect(accepted.status).toBe(200);
      const codes = (accepted.body as { recoveryCodes: string[] }).recoveryCodes;
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      expect(fakes.factors.get(adminAccount().id)?.state).toBe('active');
      expect(eventsOf('identity.invitation-accepted.v1')).toHaveLength(1);
      expect(fakes.audits.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'identity.invitation.issued',
          'identity.invitation.accepted',
          'identity.account-role.assigned',
          'identity.second-factor.activated',
        ]),
      );
      // No session is opened by the acceptance.
      expect(fakes.sessions.size).toBe(0);

      clock.advance(STEP);
      const step = await post('sign-in', code, { email: EMAIL, password: PASSWORD });
      expect(step.status).toBe(200);
      expect(step.body).toMatchObject({ code: 'second-factor-required' });
      expect(fakes.sessions.size).toBe(0);

      const signedIn = await post('second-factor', code, {
        challengeToken: (step.body as { challengeToken: string }).challengeToken,
        code: codeFor(enrol.secret),
      });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body).toMatchObject({ code: 'signed-in' });
      const cookie = cookieOf(signedIn.headers['set-cookie']);
      expect(cookie.startsWith(`${cookieName}=`)).toBe(true);
      expect(cookie).toContain('SameSite=Strict');
      // An admin session ends with the browser: never persistent.
      expect(cookie).not.toMatch(/Max-Age|Expires/i);
      expect(fakes.audits.map((a) => a.action)).toContain('identity.admin-session.opened');

      const session = await http()
        .get('/identity/admin/session')
        .set({ 'x-market-id': code, cookie: cookie.split(';', 1)[0]! });
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({
        population: 'admin',
        secondFactorActive: true,
        displayName: NAME,
        session: {
          idleTimeoutSeconds: fixture.adminSession.idleTimeoutSeconds,
        },
      });
    });

    it('never opens a session on a password alone, a replayed step or a wrong code (AC 10)', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const challengeToken = await challenge(code);
      const sameStep = codeFor(secret, clock.now().subtract(STEP));

      // The step accepted at the acceptance is spent: a replay is refused.
      const replayed = await app
        .get(CompleteAdminSignIn)
        .execute(anonymousOf(code), { challengeToken, code: sameStep, client: CLIENT });
      expect(replayed).toEqual({ ok: false, error: { code: 'second-factor.invalid' } });
      const wrong = await post('second-factor', code, { challengeToken, code: '000000' });
      expect(wrong.status).toBe(400);
      expect(wrong.body).toMatchObject({ code: 'second-factor.invalid' });
      expect(fakes.sessions.size).toBe(0);
    });

    it('refuses the code step after the credential changed between the steps (I-1)', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const challengeToken = await challenge(code);
      const account = adminAccount();
      fakes.accounts.set(account.id, {
        ...account,
        credential: { ...account.credential, changedAt: clock.now() },
        version: account.version + 1,
      });

      await expect(
        app
          .get(CompleteAdminSignIn)
          .execute(anonymousOf(code), { challengeToken, code: codeFor(secret), client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'challenge.rejected' } });
      expect(fakes.sessions.size).toBe(0);
    });

    it('accepts each recovery code once', async () => {
      await boot();
      const { recoveryCodes } = await acceptedAdmin(code);
      const first = await challenge(code);
      await expect(
        app.get(CompleteAdminSignIn).execute(anonymousOf(code), {
          challengeToken: first,
          code: recoveryCodes[0]!,
          client: CLIENT,
        }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'signed-in' } });

      const second = await challenge(code);
      await expect(
        app.get(CompleteAdminSignIn).execute(anonymousOf(code), {
          challengeToken: second,
          code: recoveryCodes[0]!,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'second-factor.invalid' } });
    });

    it('locks the factor at the Market limit of wrong codes and mails a notice (HF2)', async () => {
      await boot();
      await acceptedAdmin(code);
      const limit = fixture.secondFactorThrottle.limit;
      let last: unknown;
      for (let attempt = 0; attempt < limit; attempt += 1) {
        const challengeToken = await challenge(code);
        last = await app
          .get(CompleteAdminSignIn)
          .execute(anonymousOf(code), { challengeToken, code: '000000', client: CLIENT });
      }
      // The attempt that reaches the limit is answered as a lock (HF2).
      expect(last).toMatchObject({ ok: false, error: { code: 'second-factor.locked' } });

      // While the block lasts, the password step answers the lock and opens no challenge.
      clock.advance(STEP);
      const step = await app
        .get(SignInAdmin)
        .execute(anonymousOf(code), { email: EMAIL, password: PASSWORD, client: CLIENT });
      expect(step).toMatchObject({ ok: true, value: { code: 'second-factor.locked' } });

      const locked = eventsOf('identity.second-factor-changed.v1').filter(
        (event) => (event.payload as { change: string }).change === 'locked',
      );
      expect(locked).toHaveLength(1);
      const mailed = await app.get(SendSecondFactorMail).execute(systemOf(code), {
        delivery: delivery('identity.second-factor-mail'),
        accountId: adminAccount().id,
        change: 'locked',
        occurredAt: locked[0]!.occurredAt,
      });
      expect(mailed).toMatchObject({ ok: true });
      expect(fakes.mails.at(-1)!.to).toBe(EMAIL);
      // A notice carries no link: nothing in it can be followed to act.
      expect(fakes.mails.at(-1)!.text).not.toMatch(/https?:\/\//);
    });

    it('resets the factor by the operator routine, then enrols again by the mailed link (D, F)', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      await signedIn(code, secret);

      await expect(
        app.get(ResetAdminSecondFactor).execute(systemOf(code), { email: EMAIL }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'second-factor.reset' } });
      expect(fakes.factors.get(adminAccount().id)).toBeUndefined();
      expect([...fakes.sessions.values()].every((s) => s.session.revokedAt !== null)).toBe(true);
      expect(fakes.audits.map((a) => a.action)).toContain('identity.second-factor.reset');

      // The next correct password asks for enrolment and mails an enrolment link.
      clock.advance(STEP);
      const step = await post('sign-in', code, { email: EMAIL, password: PASSWORD });
      expect(step.body).toEqual({ code: 'second-factor-enrolment-required' });
      const requested = eventsOf('identity.one-time-link-requested.v1').at(-1)!;
      const payload = requested.payload as { linkId: Id; accountId: Id; purpose: string };
      expect(payload.purpose).toBe('enrol-second-factor');
      await app.get(SendLinkMail).execute(systemOf(code), {
        delivery: delivery('identity.link-mail'),
        linkId: payload.linkId,
        accountId: payload.accountId,
        purpose: 'enrol-second-factor',
        aggregateVersion: requested.aggregateVersion,
      });
      const mail = fakes.mails.at(-1)!.text;
      expect(mail).toContain(fixture.pages['enrol-second-factor']);
      const linkToken = /#(ml1_[A-Za-z0-9_-]{43})/.exec(mail)![1]!;

      const started = await post('second-factor/enrolment', code, {
        token: linkToken,
        password: PASSWORD,
      });
      expect(started.status).toBe(200);
      const enrol = started.body as { secret: string; challengeToken: string };
      expect(fakes.factors.get(adminAccount().id)?.state).toBe('pending');

      const confirmed = await post('second-factor/enrolment/confirm', code, {
        challengeToken: enrol.challengeToken,
        code: codeFor(enrol.secret),
      });
      expect(confirmed.status).toBe(200);
      expect((confirmed.body as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
      expect(fakes.factors.get(adminAccount().id)?.state).toBe('active');
    });

    it('a new enrolment start replaces a pending factor (F)', async () => {
      await boot();
      await acceptedAdmin(code);
      await app.get(ResetAdminSecondFactor).execute(systemOf(code), { email: EMAIL });
      const tokens: string[] = [];
      for (let round = 0; round < 2; round += 1) {
        clock.advance(STEP);
        await app
          .get(SignInAdmin)
          .execute(anonymousOf(code), { email: EMAIL, password: PASSWORD, client: CLIENT });
        const requested = eventsOf('identity.one-time-link-requested.v1').at(-1)!;
        const payload = requested.payload as { linkId: Id; accountId: Id };
        await app.get(SendLinkMail).execute(systemOf(code), {
          delivery: delivery('identity.link-mail'),
          linkId: payload.linkId,
          accountId: payload.accountId,
          purpose: 'enrol-second-factor',
          aggregateVersion: requested.aggregateVersion,
        });
        tokens.push(/#(ml1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!);
        const started = await app.get(StartSecondFactorEnrolment).execute(anonymousOf(code), {
          token: tokens[round]!,
          password: PASSWORD,
          client: CLIENT,
        });
        expect(started).toMatchObject({ ok: true });
      }
      const factor = fakes.factors.get(adminAccount().id)!;
      expect(factor.state).toBe('pending');
      expect(
        [...fakes.factors.values()].filter((f) => f.accountId === factor.accountId),
      ).toHaveLength(1);
    });

    it('confirms enrolment only with the new secret and ends every other session (D)', async () => {
      await boot();
      await acceptedAdmin(code);
      await app.get(ResetAdminSecondFactor).execute(systemOf(code), { email: EMAIL });
      clock.advance(STEP);
      await app
        .get(SignInAdmin)
        .execute(anonymousOf(code), { email: EMAIL, password: PASSWORD, client: CLIENT });
      const requested = eventsOf('identity.one-time-link-requested.v1').at(-1)!;
      const payload = requested.payload as { linkId: Id; accountId: Id };
      await app.get(SendLinkMail).execute(systemOf(code), {
        delivery: delivery('identity.link-mail'),
        linkId: payload.linkId,
        accountId: payload.accountId,
        purpose: 'enrol-second-factor',
        aggregateVersion: requested.aggregateVersion,
      });
      const token = /#(ml1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
      const started = await app
        .get(StartSecondFactorEnrolment)
        .execute(anonymousOf(code), { token, password: PASSWORD, client: CLIENT });
      if (!started.ok) throw new Error(started.error.code);

      await expect(
        app.get(ConfirmSecondFactorEnrolment).execute(anonymousOf(code), {
          challengeToken: started.value.challengeToken,
          code: '000000',
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'second-factor.invalid' } });
      await expect(
        app.get(ConfirmSecondFactorEnrolment).execute(anonymousOf(code), {
          challengeToken: started.value.challengeToken,
          code: codeFor(started.value.secret),
          client: CLIENT,
        }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'second-factor-activated' } });
      expect(
        eventsOf('identity.second-factor-changed.v1').map(
          (event) => (event.payload as { change: string }).change,
        ),
      ).toEqual(['activated', 'reset', 'activated']);
    });

    it('replaces the device and regenerates the recovery codes for the signed-in admin (E)', async () => {
      await boot();
      const { secret, recoveryCodes } = await acceptedAdmin(code);
      const context = await signedIn(code, secret);

      clock.advance(STEP);
      const started = await app
        .get(StartSecondFactorReplacement)
        .execute(context, { code: codeFor(secret) });
      if (!started.ok) throw new Error(started.error.code);
      // The current device keeps working until the new one proves itself.
      expect(fakes.factors.get(adminAccount().id)?.state).toBe('active');

      clock.advance(STEP);
      const replaced = await app
        .get(CompleteSecondFactorReplacement)
        .execute(context, { code: codeFor(started.value.secret) });
      expect(replaced).toMatchObject({ ok: true, value: { code: 'second-factor-replaced' } });

      clock.advance(STEP);
      const regenerated = await app
        .get(RegenerateRecoveryCodes)
        .execute(context, { code: codeFor(started.value.secret) });
      if (!regenerated.ok) throw new Error(regenerated.error.code);
      expect(regenerated.value.recoveryCodes).toHaveLength(10);
      expect(regenerated.value.recoveryCodes).not.toContain(recoveryCodes[1]);

      // The old device's codes no longer sign in.
      const challengeToken = await challenge(code);
      await expect(
        app
          .get(CompleteAdminSignIn)
          .execute(anonymousOf(code), { challengeToken, code: codeFor(secret), client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'second-factor.invalid' } });
      expect(fakes.audits.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'identity.second-factor.replaced',
          'identity.second-factor.recovery-codes-regenerated',
        ]),
      );
    });

    it('changes the password only with a code (Hassan I2 (b)); a reset keeps the factor (A, I-4)', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const context = await signedIn(code, secret);

      const withoutCode = await app.get(ChangePassword).execute(context, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        client: CLIENT,
      });
      expect(withoutCode).toMatchObject({ ok: false, error: { code: 'validation.failed' } });

      clock.advance(STEP);
      const changed = await app.get(ChangePassword).execute(context, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        code: codeFor(secret),
        client: CLIENT,
      });
      expect(changed).toMatchObject({ ok: true });
      expect(fakes.factors.get(adminAccount().id)?.state).toBe('active');

      // The reset request is answered the same way, and the next sign-in still asks for a code.
      const reset = await post('password-reset-email', code, { email: EMAIL });
      expect(reset.status).toBe(202);
      clock.advance(STEP);
      const step = await app
        .get(SignInAdmin)
        .execute(anonymousOf(code), { email: EMAIL, password: NEW_PASSWORD, client: CLIENT });
      expect(step).toMatchObject({ ok: true, value: { code: 'second-factor-required' } });
    });

    it('refuses a second first-admin invitation and a second first admin (G)', async () => {
      await boot();
      await app.get(SeedRoles).execute(systemOf(code), {});
      await expect(
        app.get(IssueFirstAdminInvitation).execute(systemOf(code), { email: EMAIL }),
      ).resolves.toMatchObject({ ok: true, value: { replaced: false } });
      await expect(
        app.get(IssueFirstAdminInvitation).execute(systemOf(code), { email: EMAIL }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.already-pending' } });

      // After its lifetime the pending invitation is replaced.
      clock.advance(Temporal.Duration.from({ minutes: fixture.invitationMinutes.admin + 1 }));
      await expect(
        app.get(IssueFirstAdminInvitation).execute(systemOf(code), { email: EMAIL }),
      ).resolves.toMatchObject({ ok: true, value: { replaced: true } });
    });

    it('fails closed in a Market without the admin keys: no invitation, no admin sign-in', async () => {
      await boot({ withoutAdminKeys: true });
      await app.get(SeedRoles).execute(systemOf(code), {});

      await expect(
        app.get(IssueFirstAdminInvitation).execute(systemOf(code), { email: EMAIL }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(fakes.invitations.size).toBe(0);
      const signIn = await post('sign-in', code, { email: EMAIL, password: PASSWORD });
      expect(signIn.status).toBe(503);
      expect(signIn.body).toEqual({ statusCode: 503, code: 'access.unavailable' });
      expect(fakes.sessions.size).toBe(0);
    });

    it('refuses a first admin once one exists', async () => {
      await boot();
      await acceptedAdmin(code);
      await expect(
        app.get(IssueFirstAdminInvitation).execute(systemOf(code), { email: 'other@example.com' }),
      ).resolves.toEqual({ ok: false, error: { code: 'first-admin.exists' } });
    });

    it('refuses an acceptance after the enrolment secret expired (15 minutes)', async () => {
      await boot();
      const token = await invited(code);
      const ready = await app
        .get(StartAdminInvitationAcceptance)
        .execute(anonymousOf(code), { token, client: CLIENT });
      if (!ready.ok) throw new Error(ready.error.code);
      clock.advance(Temporal.Duration.from({ minutes: 16 }));

      await expect(
        app.get(AcceptAdminInvitation).execute(anonymousOf(code), {
          token,
          displayName: NAME,
          password: PASSWORD,
          secret: ready.value.secret,
          tag: ready.value.tag,
          expiresAt: ready.value.expiresAt.toString(),
          code: codeFor(ready.value.secret),
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.enrolment-expired' } });
      expect(fakes.accounts.size).toBe(0);
    });

    it('refuses an acceptance whose secret was altered (the tag binds it)', async () => {
      await boot();
      const token = await invited(code);
      const ready = await app
        .get(StartAdminInvitationAcceptance)
        .execute(anonymousOf(code), { token, client: CLIENT });
      if (!ready.ok) throw new Error(ready.error.code);
      const other = await app
        .get(StartAdminInvitationAcceptance)
        .execute(anonymousOf(code), { token, client: CLIENT });
      if (!other.ok) throw new Error(other.error.code);

      await expect(
        app.get(AcceptAdminInvitation).execute(anonymousOf(code), {
          token,
          displayName: NAME,
          password: PASSWORD,
          secret: other.value.secret,
          tag: ready.value.tag,
          expiresAt: ready.value.expiresAt.toString(),
          code: codeFor(other.value.secret),
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.enrolment-expired' } });
      expect(fakes.accounts.size).toBe(0);
    });

    it('passes the per-kind lifetimes as the never-dispatched invitation cut-offs (ruling 4)', async () => {
      await boot();
      const purge = jest.spyOn(fakes.invitationRepository, 'purge');

      await app.get(PurgeExpired).execute(systemOf(code), {});

      expect(purge).toHaveBeenCalledTimes(1);
      const [market, now, , cutOffs] = purge.mock.calls[0]!;
      expect(market.marketId).toBe(code);
      expect(now.toString()).toBe(START.toString());
      expect(
        Object.fromEntries(Object.entries(cutOffs ?? {}).map(([k, v]) => [k, v.toString()])),
      ).toEqual({
        admin: START.subtract({ minutes: fixture.invitationMinutes.admin }).toString(),
        'seller-owner': START.subtract({
          minutes: fixture.invitationMinutes['seller-owner'],
        }).toString(),
        staff: START.subtract({ minutes: fixture.invitationMinutes.staff }).toString(),
      });
      purge.mockRestore();
    });
  });

  // PR #162 round 1: boundaries, I-3, I-4, I-6, HF5, L3, B, and the refusals of the signed-in
  // steps (Sajad gaps 1 to 7, Hassan L2 and L3).
  describe.each(TEST_MARKETS)('in market %s, at the edges (PR #162)', (code) => {
    const fixture = adminConfigOf(code);
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const SECOND = Temporal.Duration.from({ seconds: 1 });

    /** The attempts on the account's `second-factor.account` counter (HF2). */
    const secondFactorAttempts = () =>
      [...fakes.throttles.values()]
        .filter((row) => row.kind === 'second-factor.account')
        .reduce((sum, row) => sum + row.attempts, 0);

    /** A sealed secret that no longer opens (I-3). */
    const tamperSecret = () => {
      const factor = fakes.factors.get(adminAccount().id)!;
      fakes.factors.set(factor.accountId, { ...factor, secretCiphertext: 'fake1|tampered' });
    };

    const complete = (challengeToken: string, appCode: string) =>
      app
        .get(CompleteAdminSignIn)
        .execute(anonymousOf(code), { challengeToken, code: appCode, client: CLIENT });

    /** Wrong codes until the counter reaches the Market limit, which locks the factor (HF2). */
    async function lockFactor() {
      while (secondFactorAttempts() < fixture.secondFactorThrottle.limit) {
        await complete(await challenge(code), '000000');
      }
      expect(fakes.factors.get(adminAccount().id)?.lockedAt).not.toBeNull();
    }

    /** A password-reset link of the admin, as the mail carries it. */
    async function resetLink(): Promise<string> {
      await app
        .get(RequestPasswordReset)
        .execute(anonymousOf(code), { population: 'admin', email: EMAIL, origin: CLIENT.origin });
      const requested = eventsOf('identity.one-time-link-requested.v1').at(-1)!;
      const payload = requested.payload as { linkId: Id; accountId: Id; purpose: string };
      expect(payload.purpose).toBe('reset-password');
      await app.get(SendLinkMail).execute(systemOf(code), {
        delivery: delivery('identity.link-mail'),
        linkId: payload.linkId,
        accountId: payload.accountId,
        purpose: 'reset-password',
        aggregateVersion: requested.aggregateVersion,
      });
      return /#(ml1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
    }

    /** Starts the acceptance now; `accept` sends it later with `expiresAt` as `shift` makes it. */
    async function acceptAt(token: string, shift: (expiresAt: string) => string) {
      const ready = await app
        .get(StartAdminInvitationAcceptance)
        .execute(anonymousOf(code), { token, client: CLIENT });
      if (!ready.ok) throw new Error(ready.error.code);
      const value = ready.value;
      return {
        ready: value,
        accept: () =>
          app.get(AcceptAdminInvitation).execute(anonymousOf(code), {
            token,
            displayName: NAME,
            password: PASSWORD,
            secret: value.secret,
            tag: value.tag,
            expiresAt: shift(value.expiresAt.toString()),
            code: codeFor(value.secret),
            client: CLIENT,
          }),
      };
    }
    const asIssued = (expiresAt: string) => expiresAt;

    it('one wrong code below the limit does not lock; the block holds to its end and then lifts', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const { limit, blockMinutes } = fixture.secondFactorThrottle;
      for (let attempt = 0; attempt < limit - 1; attempt += 1) {
        await expect(complete(await challenge(code), '000000')).resolves.toEqual({
          ok: false,
          error: { code: 'second-factor.invalid' },
        });
      }
      expect(fakes.factors.get(adminAccount().id)?.lockedAt).toBeNull();
      expect(secondFactorAttempts()).toBe(limit - 1);

      // The attempt that reaches the limit locks.
      await expect(complete(await challenge(code), '000000')).resolves.toMatchObject({
        ok: false,
        error: { code: 'second-factor.locked', retryAfterSeconds: blockMinutes * 60 },
      });
      const lockedAt = fakes.factors.get(adminAccount().id)!.lockedAt!;
      expect(lockedAt.toString()).toBe(clock.now().toString());

      // One second before the block ends it still holds.
      clock.advance(Temporal.Duration.from({ minutes: blockMinutes }).subtract(SECOND));
      await expect(
        app
          .get(SignInAdmin)
          .execute(anonymousOf(code), { email: EMAIL, password: PASSWORD, client: CLIENT }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'second-factor.locked' } });

      // Once it ended, a correct code signs in.
      clock.advance(SECOND);
      const challengeToken = await challenge(code);
      await expect(complete(challengeToken, codeFor(secret))).resolves.toMatchObject({
        ok: true,
        value: { code: 'signed-in' },
      });
    });

    it('accepts a challenge up to its last second and refuses it at and after its expiry', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const lifetime = Temporal.Duration.from({ seconds: fixture.challengeLifetimeSeconds });

      const first = await challenge(code);
      clock.advance(lifetime.subtract(SECOND));
      await expect(complete(first, codeFor(secret))).resolves.toMatchObject({
        ok: true,
        value: { code: 'signed-in' },
      });

      // An expired challenge after the password step: exactly at its expiry, then after it.
      const second = await challenge(code);
      clock.advance(lifetime);
      await expect(complete(second, codeFor(secret))).resolves.toEqual({
        ok: false,
        error: { code: 'challenge.rejected' },
      });
      clock.advance(SECOND);
      await expect(complete(second, codeFor(secret))).resolves.toEqual({
        ok: false,
        error: { code: 'challenge.rejected' },
      });
      expect(fakes.sessions.size).toBe(1);
    });

    it('accepts the code of the previous time step and refuses one two steps back (I-2)', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const challengeToken = await challenge(code);
      // Steps never accepted before, so a refusal is the window, not a replay.
      clock.advance(STEP);
      clock.advance(STEP);
      clock.advance(STEP);
      const twoBack = codeFor(secret, clock.now().subtract(STEP).subtract(STEP));
      const previous = codeFor(secret, clock.now().subtract(STEP));
      expect(twoBack).not.toBe(previous);

      await expect(complete(challengeToken, twoBack)).resolves.toEqual({
        ok: false,
        error: { code: 'second-factor.invalid' },
      });
      await expect(complete(challengeToken, previous)).resolves.toMatchObject({
        ok: true,
        value: { code: 'signed-in' },
      });
    });

    it('refuses a challenge and an invitation of one Market in the other Market', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const challengeToken = await challenge(code);
      await expect(
        app
          .get(CompleteAdminSignIn)
          .execute(anonymousOf(other), { challengeToken, code: codeFor(secret), client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'challenge.rejected' } });
      expect(fakes.sessions.size).toBe(0);

      fakes.reset();
      const token = await invited(code);
      await expect(
        app
          .get(StartAdminInvitationAcceptance)
          .execute(anonymousOf(other), { token, client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.rejected' } });
    });

    it('accepts the enrolment secret up to 15 minutes and refuses it at exactly 15 minutes', async () => {
      await boot();
      const token = await invited(code);
      const early = await acceptAt(token, asIssued);
      expect(early.ready.expiresAt.toString()).toBe(START.add({ minutes: 15 }).toString());

      clock.advance(Temporal.Duration.from({ minutes: 15 }));
      await expect(early.accept()).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.enrolment-expired' },
      });
      expect(fakes.accounts.size).toBe(0);

      const late = await acceptAt(token, asIssued);
      clock.advance(Temporal.Duration.from({ minutes: 15 }).subtract(SECOND));
      await expect(late.accept()).resolves.toMatchObject({ ok: true });
    });

    it('refuses an expiresAt moved later without its tag (the tag binds it)', async () => {
      await boot();
      const token = await invited(code);
      const moved = await acceptAt(token, (expiresAt) =>
        Temporal.Instant.from(expiresAt).add({ hours: 1 }).toString(),
      );
      await expect(moved.accept()).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.enrolment-expired' },
      });
      expect(fakes.accounts.size).toBe(0);
    });

    it('refuses an invitation at exactly its lifetime and uses it one second before', async () => {
      await boot();
      const token = await invited(code);
      const lifetime = Temporal.Duration.from({ minutes: fixture.invitationMinutes.admin });

      // Started one minute before the end and sent exactly at it: the invitation decides.
      clock.advance(lifetime.subtract({ minutes: 1 }));
      const started = await acceptAt(token, asIssued);
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      await expect(started.accept()).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      await expect(
        app
          .get(StartAdminInvitationAcceptance)
          .execute(anonymousOf(code), { token, client: CLIENT }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.rejected' } });
      expect(fakes.accounts.size).toBe(0);

      // A new invitation, one second before its end: still usable.
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      const again = await invited(code);
      clock.advance(lifetime.subtract(SECOND));
      const ready = await acceptAt(again, asIssued);
      await expect(ready.accept()).resolves.toMatchObject({ ok: true });
    });

    it('refuses the acceptance when the invited role is no longer the Market system role (I-6)', async () => {
      await boot();
      const token = await invited(code);
      const ready = await acceptAt(token, asIssued);
      const invitation = [...fakes.invitations.values()].at(-1)!;
      const role = fakes.roles.get(invitation.roleId)!;

      // The role read in this Market's context is not found when it belongs to another Market.
      fakes.roles.set(role.id, { ...role, marketId: other as typeof role.marketId });
      await expect(ready.accept()).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      // A role that is no longer a system role is refused too.
      fakes.roles.set(role.id, { ...role, kind: 'custom', seedCode: null, seedVersion: null });
      await expect(ready.accept()).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      fakes.roles.delete(role.id);
      await expect(ready.accept()).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      expect(fakes.accounts.size).toBe(0);
      expect(eventsOf('identity.invitation-accepted.v1')).toHaveLength(0);
    });

    it('refuses a second acceptance once the Market has an active admin (HF5) or any admin account (L3)', async () => {
      await boot();
      // Two first-admin invitations pending at once, as the READ COMMITTED race could leave them.
      const first = await invited(code);
      const [firstId, firstState] = [...fakes.invitations.entries()].at(-1)!;
      fakes.invitations.delete(firstId);
      const second = await invited(code, 'second.admin@example.com');
      fakes.invitations.set(firstId, firstState);

      const one = await acceptAt(first, asIssued);
      const two = await acceptAt(second, asIssued);
      await expect(one.accept()).resolves.toMatchObject({ ok: true });

      // HF5 alone: the admin-account check answers no, the active holder still refuses.
      const exists = jest
        .spyOn(fakes.accountRepository, 'existsInPopulation')
        .mockResolvedValue(false);
      const holder = jest.spyOn(fakes.assignmentRepository, 'hasActiveHolder');
      clock.advance(STEP);
      await expect(two.accept()).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      await expect(holder.mock.results.at(-1)!.value).resolves.toBe(true);
      exists.mockRestore();
      holder.mockRestore();

      // L3 alone: the first admin is disabled (no active holder); its account still refuses.
      const admin = adminAccount();
      fakes.accounts.set(admin.id, { ...admin, status: 'disabled', version: admin.version + 1 });
      clock.advance(STEP);
      await expect(two.accept()).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      expect(
        [...fakes.accounts.values()].filter((account) => account.population === 'admin'),
      ).toHaveLength(1);
    });

    it('answers a secret that cannot be opened as a wrong code, counts it and alarms (I-3)', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const context = await signedIn(code, secret);
      const alarms = jest.spyOn(Logger.prototype, 'error');
      const integrityAlarms = () =>
        alarms.mock.calls.filter(
          ([line]) =>
            typeof line === 'object' &&
            line !== null &&
            (line as { alarm?: string }).alarm === 'integrity',
        ).length;
      tamperSecret();

      const challengeToken = await challenge(code);
      await expect(complete(challengeToken, codeFor(secret))).resolves.toEqual({
        ok: false,
        error: { code: 'second-factor.invalid' },
      });
      expect(secondFactorAttempts()).toBe(1);
      expect(integrityAlarms()).toBe(1);

      clock.advance(STEP);
      await expect(
        app.get(RegenerateRecoveryCodes).execute(context, { code: codeFor(secret) }),
      ).resolves.toEqual({ ok: false, error: { code: 'second-factor.invalid' } });
      expect(secondFactorAttempts()).toBe(2);
      expect(integrityAlarms()).toBe(2);

      clock.advance(STEP);
      await expect(
        app.get(ChangePassword).execute(context, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          code: codeFor(secret),
          client: CLIENT,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'second-factor.invalid' } });
      expect(secondFactorAttempts()).toBe(3);
      expect(integrityAlarms()).toBe(3);
      expect(JSON.stringify(alarms.mock.calls)).not.toContain(secret);
      alarms.mockRestore();
    });

    it('a password reset and a change drop a waiting replacement and keep the counter (B, I-4)', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      let context = await signedIn(code, secret);
      const pending = () => fakes.factors.get(adminAccount().id)!.pendingSecretCiphertext;

      // One wrong code stays counted through both.
      clock.advance(STEP);
      await expect(
        app.get(RegenerateRecoveryCodes).execute(context, { code: '000000' }),
      ).resolves.toEqual({ ok: false, error: { code: 'second-factor.invalid' } });
      expect(secondFactorAttempts()).toBe(1);

      clock.advance(STEP);
      await expect(
        app.get(StartSecondFactorReplacement).execute(context, { code: codeFor(secret) }),
      ).resolves.toMatchObject({ ok: true });
      expect(pending()).not.toBeNull();

      const token = await resetLink();
      await expect(
        app.get(ResetPassword).execute(anonymousOf(code), {
          population: 'admin',
          token,
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: true, value: { code: 'password-changed' } });
      expect(pending()).toBeNull();
      expect(fakes.factors.get(adminAccount().id)?.state).toBe('active');
      expect(secondFactorAttempts()).toBe(1);

      // Signed in again with the new password, a replacement started, then the password changed.
      const challengeToken = await challenge(code, NEW_PASSWORD);
      await expect(complete(challengeToken, codeFor(secret))).resolves.toMatchObject({ ok: true });
      const session = [...fakes.sessions.values()].at(-1)!.session;
      context = testCallContext(
        marketOf(code),
        testAuthenticatedActor(marketOf(code), {
          population: 'admin',
          accountId: adminAccount().id,
          sessionId: session.id,
          sellerId: null,
        }),
        'admin-e2e-0004',
      );
      clock.advance(STEP);
      await expect(
        app.get(StartSecondFactorReplacement).execute(context, { code: codeFor(secret) }),
      ).resolves.toMatchObject({ ok: true });
      expect(pending()).not.toBeNull();
      // Hassan L1: even a session that looks longer than the Market's admin lifetime keeps a
      // browser-session cookie; an admin cookie is never persistent.
      const stored = fakes.sessions.get(session.id)!;
      fakes.sessions.set(session.id, {
        ...stored,
        session: {
          ...stored.session,
          absoluteExpiresAt: stored.session.absoluteExpiresAt.add({ hours: 24 }),
        },
      });
      clock.advance(STEP);
      await expect(
        app.get(ChangePassword).execute(context, {
          currentPassword: NEW_PASSWORD,
          newPassword: PASSWORD,
          code: codeFor(secret),
          client: CLIENT,
        }),
      ).resolves.toMatchObject({ ok: true, value: { cookieMaxAgeSeconds: null } });
      expect(pending()).toBeNull();
      expect(secondFactorAttempts()).toBe(1);
    });

    it('a locked factor stays locked after a password reset (I-4)', async () => {
      await boot();
      await acceptedAdmin(code);
      await lockFactor();
      const attempts = secondFactorAttempts();

      const token = await resetLink();
      await expect(
        app.get(ResetPassword).execute(anonymousOf(code), {
          population: 'admin',
          token,
          password: NEW_PASSWORD,
          client: CLIENT,
        }),
      ).resolves.toEqual({ ok: true, value: { code: 'password-changed' } });
      expect(secondFactorAttempts()).toBe(attempts);

      clock.advance(STEP);
      await expect(
        app
          .get(SignInAdmin)
          .execute(anonymousOf(code), { email: EMAIL, password: NEW_PASSWORD, client: CLIENT }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'second-factor.locked' } });
    });

    it('refuses a password change with a wrong code or a locked factor', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const context = await signedIn(code, secret);
      const change = (appCode: string) =>
        app.get(ChangePassword).execute(context, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          code: appCode,
          client: CLIENT,
        });

      clock.advance(STEP);
      await expect(change('000000')).resolves.toMatchObject({
        ok: false,
        error: { code: 'second-factor.invalid' },
      });
      expect(secondFactorAttempts()).toBe(1);
      // The password is unchanged: the old one still opens the password step.
      clock.advance(STEP);
      await expect(
        app
          .get(SignInAdmin)
          .execute(anonymousOf(code), { email: EMAIL, password: PASSWORD, client: CLIENT }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'second-factor-required' } });

      await lockFactor();
      clock.advance(STEP);
      await expect(change(codeFor(secret))).resolves.toMatchObject({
        ok: false,
        error: { code: 'second-factor.locked' },
      });
    });

    it('refuses a replacement and a regeneration with a wrong code, and to a non-admin', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const context = await signedIn(code, secret);

      clock.advance(STEP);
      await expect(
        app.get(StartSecondFactorReplacement).execute(context, { code: '000000' }),
      ).resolves.toEqual({ ok: false, error: { code: 'second-factor.invalid' } });
      await expect(
        app.get(RegenerateRecoveryCodes).execute(context, { code: '000000' }),
      ).resolves.toEqual({ ok: false, error: { code: 'second-factor.invalid' } });
      const started = await app
        .get(StartSecondFactorReplacement)
        .execute(context, { code: codeFor(secret) });
      if (!started.ok) throw new Error(started.error.code);
      // The completion takes only the new device's code: the current one is a wrong code.
      clock.advance(STEP);
      await expect(
        app.get(CompleteSecondFactorReplacement).execute(context, { code: codeFor(secret) }),
      ).resolves.toEqual({ ok: false, error: { code: 'second-factor.invalid' } });
      expect(secondFactorAttempts()).toBe(3);
      expect(fakes.factors.get(adminAccount().id)?.pendingSecretCiphertext).not.toBeNull();

      const market = marketOf(code);
      const customer = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'customer',
          accountId: adminAccount().id,
          sessionId: [...fakes.sessions.values()].at(-1)!.session.id,
          sellerId: null,
        }),
        'admin-e2e-0005',
      );
      for (const run of [
        () => app.get(StartSecondFactorReplacement).execute(customer, { code: codeFor(secret) }),
        () => app.get(CompleteSecondFactorReplacement).execute(customer, { code: '000000' }),
        () => app.get(RegenerateRecoveryCodes).execute(customer, { code: codeFor(secret) }),
      ]) {
        await expect(run()).resolves.toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
      expect(secondFactorAttempts()).toBe(3);
    });

    it('keeps a wrong code counted when its closing unit fails, and gives back a matched one (Mojtaba)', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const context = await signedIn(code, secret);
      /** The closing unit's first read fails once; the reservation unit's read goes through. */
      const failClosingRead = () => {
        const original = fakes.factorRepository.findByAccount.bind(fakes.factorRepository);
        let reads = 0;
        return jest
          .spyOn(fakes.factorRepository, 'findByAccount')
          .mockImplementation((market, accountId) => {
            reads += 1;
            return reads === 2
              ? Promise.reject(new Error('unit failed'))
              : original(market, accountId);
          });
      };

      clock.advance(STEP);
      let spy = failClosingRead();
      await expect(
        app.get(RegenerateRecoveryCodes).execute(context, { code: '000000' }),
      ).rejects.toThrow('unit failed');
      spy.mockRestore();
      expect(secondFactorAttempts()).toBe(1);

      clock.advance(STEP);
      spy = failClosingRead();
      await expect(
        app.get(RegenerateRecoveryCodes).execute(context, { code: codeFor(secret) }),
      ).rejects.toThrow('unit failed');
      spy.mockRestore();
      expect(secondFactorAttempts()).toBe(1);
    });

    it('keeps a wrong recovery code counted when the closing unit fails, in every code step (Hassan, round 2)', async () => {
      await boot();
      const { secret, recoveryCodes } = await acceptedAdmin(code);
      const context = await signedIn(code, secret);
      // Well formed, so the check outside the unit answers `recovery`; no stored code has it.
      const wrongRecovery = '0000000000';
      expect(recoveryCodes).not.toContain(wrongRecovery);
      /** The closing unit's credential lock fails once; nothing of the unit is kept. */
      const failClosingLock = () =>
        jest
          .spyOn(fakes.accountRepository, 'lockCredential')
          .mockRejectedValueOnce(new Error('unit failed'));

      // The sign-in code step.
      const challengeToken = await challenge(code);
      let spy = failClosingLock();
      await expect(complete(challengeToken, wrongRecovery)).rejects.toThrow('unit failed');
      spy.mockRestore();
      expect(secondFactorAttempts()).toBe(1);

      // A signed-in step, which now takes the credential lock first (Mojtaba, round 2).
      clock.advance(STEP);
      spy = failClosingLock();
      await expect(
        app.get(RegenerateRecoveryCodes).execute(context, { code: wrongRecovery }),
      ).rejects.toThrow('unit failed');
      expect(spy).toHaveBeenCalledWith(expect.anything(), adminAccount().id);
      spy.mockRestore();
      expect(secondFactorAttempts()).toBe(2);

      // The admin's password change: the password counters come back, the code's attempt does not.
      clock.advance(STEP);
      spy = failClosingLock();
      await expect(
        app.get(ChangePassword).execute(context, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          code: wrongRecovery,
          client: CLIENT,
        }),
      ).rejects.toThrow('unit failed');
      spy.mockRestore();
      expect(secondFactorAttempts()).toBe(3);

      // A recovery code the unit spent before it failed is proven, and its attempt comes back.
      clock.advance(STEP);
      // The unit's own release, right after the spend, fails (the fakes keep no rollback).
      const failAfterSpend = jest
        .spyOn(fakes.throttleRepository, 'release')
        .mockRejectedValueOnce(new Error('unit failed'));
      await expect(
        app.get(RegenerateRecoveryCodes).execute(context, { code: recoveryCodes[0]! }),
      ).rejects.toThrow('unit failed');
      failAfterSpend.mockRestore();
      expect(secondFactorAttempts()).toBe(3);
    });

    it('refuses the signed-in steps over HTTP without the CSRF token', async () => {
      await boot();
      const { secret } = await acceptedAdmin(code);
      const challengeToken = await challenge(code);
      const done = await complete(challengeToken, codeFor(secret));
      if (!done.ok) throw new Error(done.error.code);
      const cookie = `__Host-session-admin-${code}=${done.value.token}`;

      for (const path of [
        'second-factor/replacement',
        'second-factor/replacement/confirm',
        'second-factor/recovery-codes',
      ]) {
        const refused = await post(path, code, { code: '000000' }, { cookie });
        expect(refused.status).toBe(403);
        expect(refused.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      }
      expect(secondFactorAttempts()).toBe(0);

      // With the token, the same request reaches the use case.
      const wrong = await post(
        'second-factor/replacement',
        code,
        { code: '000000' },
        { cookie, 'x-csrf-token': csrfTokenFor(done.value.token) },
      );
      expect(wrong.status).toBe(400);
      expect(wrong.body).toMatchObject({ code: 'second-factor.invalid' });
    });
  });
});
