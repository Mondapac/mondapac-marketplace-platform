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
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { ADMIN_MARKET_FIXTURE, overrideAdminMarketPolicy } from './support/admin-market-fixture';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// Admin sign-in with its second factor, the first-admin invitation, enrolment, devices and the
// break-glass reset (identity design 3.4 to 3.7, 6.1 to 6.8, 7.2 to 7.4; slice 7b items A to I
// and Hassan I-1 to I-7): the real guards, controllers and use cases, with identity's database
// ports and the mail transport as in-memory fakes and a fixed clock. The admin keys of the
// Market configuration are not there yet (another track adds them), so the AU and ZZ values come
// from ADMIN_MARKET_FIXTURE. The anonymous HTTP limit of ZZ is 10 a minute, so each case sends
// only the requests it is about over HTTP and prepares the rest through the use cases.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const EMAIL = 'Root.Admin@Example.com';
const NAME = 'Maryam Haddad';
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a different long passphrase';
const CLIENT = { origin: '203.0.113.7', address: '203.0.113.7' };
const STEP = Temporal.Duration.from({ seconds: TOTP.periodSeconds });

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
      .set({ 'x-market-id': market, ...headers })
      .send(body as object);

  async function boot() {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      override: (builder) =>
        overrideAdminMarketPolicy(fakes.override(builder)).overrideProvider(CLOCK).useValue(clock),
    }));
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
  async function invited(code: string): Promise<string> {
    await app.get(SeedRoles).execute(systemOf(code), {});
    const issued = await app.get(IssueFirstAdminInvitation).execute(systemOf(code), {
      email: EMAIL,
    });
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
    const fixture = ADMIN_MARKET_FIXTURE[code];
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
        const started = await app
          .get(StartSecondFactorEnrolment)
          .execute(anonymousOf(code), {
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
});
