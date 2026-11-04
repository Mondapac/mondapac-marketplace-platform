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
import { IDENTITY_FACADE, type IdentityFacade } from '../src/modules/identity';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SignInSeller } from '../src/modules/identity/application/use-cases/sign-in-seller.use-case';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import { decodeBase32Secret } from '../src/modules/identity/domain/otpauth';
import { TOTP } from '../src/modules/identity/domain/totp';
import { hotp } from '../src/modules/identity/infrastructure/second-factor/totp';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { traceCredentialOrder } from './support/credential-order';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// A seller's own second factor over HTTP (identity design 3.6, 6.3, 7; owner decision 2026-10-08:
// optional for a seller at launch, compulsory before payouts): enrolment from a signed-in session
// with the password, the code step after the password step, recovery codes and removal. The real
// guards, controllers and use cases, with identity's database ports and the mail transport as
// in-memory fakes and a fixed clock (a time step is accepted once, so the clock moves a step
// between two codes).

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const STEP = Temporal.Duration.from({ seconds: TOTP.periodSeconds });
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Owner@Example.com';
const NAME = 'Amina Rahman';

const fakes = new IdentityFakes();
let clock: FixedClock;

const cookieOf = (setCookie: unknown): string => {
  const [line] = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return line!.split(';', 1)[0]!;
};

describe('seller second factor over HTTP (integration)', () => {
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
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
  }

  const systemOf = (code: string) =>
    testCallContext(testMarketContext(code, PLATFORM_TENANT_ID), 'system', 'seller-2fa-0001');

  /** The code the authenticator app shows now. */
  const codeFor = (secret: string, at: Temporal.Instant = clock.now()) =>
    hotp(decodeBase32Secret(secret)!, Math.floor(at.epochMilliseconds / 1000 / TOTP.periodSeconds));

  /** Signs up and confirms the email; the seller is approved (AU starts pending). */
  async function signedUpSeller(code: string) {
    await app.get(SeedRoles).execute(systemOf(code), {});
    const signedUp = await post('sign-up', code, {
      displayName: NAME,
      email: EMAIL,
      password: PASSWORD,
    });
    expect(signedUp.status).toBe(202);
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
    const token = /#(ml1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
    const confirmed = await post('confirm-email', code, { token, password: PASSWORD });
    expect(confirmed.status).toBe(200);
    const [seller] = [...fakes.sellerAccess.values()];
    fakes.seedSellerAccess({ ...seller!, state: 'approved' });
    return {
      cookie: cookieOf(confirmed.headers['set-cookie']),
      csrf: (confirmed.body as { csrfToken: string }).csrfToken,
    };
  }

  /** Enrols through the routes; answers the app's secret and the recovery codes. */
  async function enrolled(code: string, session: { cookie: string; csrf: string }) {
    const headers = { cookie: session.cookie, 'x-csrf-token': session.csrf };
    const started = await post('second-factor/enrolment', code, { password: PASSWORD }, headers);
    expect(started.status).toBe(200);
    const body = started.body as { challengeToken: string; secret: string };
    clock.advance(STEP);
    const confirmed = await post('second-factor/enrolment/confirm', code, {
      challengeToken: body.challengeToken,
      code: codeFor(body.secret),
    });
    expect(confirmed.status).toBe(200);
    return {
      secret: body.secret,
      recoveryCodes: (confirmed.body as { recoveryCodes: string[] }).recoveryCodes,
    };
  }

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app.close();
  });

  it('logs outcomes with the correlation id, never the password, secret, code or token', async () => {
    await boot();
    const session = await signedUpSeller('AU');
    const headers = { cookie: session.cookie, 'x-csrf-token': session.csrf };

    const started = await post('second-factor/enrolment', 'AU', { password: PASSWORD }, headers);
    const body = started.body as { challengeToken: string; secret: string; otpauthUri: string };
    clock.advance(STEP);
    const appCode = codeFor(body.secret);
    const confirmed = await post('second-factor/enrolment/confirm', 'AU', {
      challengeToken: body.challengeToken,
      code: appCode,
    });

    expect([started.status, confirmed.status]).toEqual([200, 200]);
    expect(logLines.find((l) => l.msg === 'identity.seller-enrolment')).toMatchObject({
      outcome: 'second-factor-enrolment-started',
      marketId: 'AU',
      correlationId: started.headers['x-correlation-id'] as string,
    });
    const all = JSON.stringify(logLines);
    for (const secret of [
      EMAIL.toLowerCase(),
      PASSWORD,
      body.secret,
      body.challengeToken,
      appCode,
      session.cookie.split('=')[1]!,
      ...(confirmed.body as { recoveryCodes: string[] }).recoveryCodes,
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    /** Signs in through both steps; answers the headers of the new session. */
    async function signedInWithFactor(c: string, secret: string) {
      clock.advance(STEP);
      const step = await post('sign-in', c, { email: EMAIL, password: PASSWORD });
      clock.advance(STEP);
      const done = await post('sign-in/second-factor', c, {
        challengeToken: (step.body as { challengeToken: string }).challengeToken,
        code: codeFor(secret),
      });
      return {
        cookie: cookieOf(done.headers['set-cookie']),
        'x-csrf-token': (done.body as { csrfToken: string }).csrfToken,
      };
    }

    it('enrols with the password and a first code, then signs in only with a code', async () => {
      await boot();
      const session = await signedUpSeller(code);
      const headers = { cookie: session.cookie, 'x-csrf-token': session.csrf };

      const started = await post('second-factor/enrolment', code, { password: PASSWORD }, headers);
      expect(started.status).toBe(200);
      expect(started.headers['cache-control']).toBe('no-store');
      expect(started.body).toMatchObject({
        code: 'second-factor-enrolment-started',
        otpauthUri: expect.stringMatching(/^otpauth:\/\/totp\//) as unknown,
      });
      const enrol = started.body as { challengeToken: string; secret: string };
      // A pending factor does not ask for a code at sign-in.
      expect([...fakes.factors.values()].map((f) => f.state)).toEqual(['pending']);

      clock.advance(STEP);
      const confirmed = await post('second-factor/enrolment/confirm', code, {
        challengeToken: enrol.challengeToken,
        code: codeFor(enrol.secret),
      });
      expect(confirmed.status).toBe(200);
      expect(confirmed.headers['cache-control']).toBe('no-store');
      const codes = (confirmed.body as { recoveryCodes: string[] }).recoveryCodes;
      expect(new Set(codes).size).toBe(10);
      expect([...fakes.factors.values()].map((f) => f.state)).toEqual(['active']);
      // Every session of the account ended.
      const ended = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie: session.cookie });
      expect(ended.body).toEqual({ statusCode: 401, code: 'session.invalid' });

      // The password step no longer opens a session.
      clock.advance(STEP);
      const step = await post('sign-in', code, { email: EMAIL, password: PASSWORD });
      expect(step.status).toBe(200);
      expect(step.headers['set-cookie']).toBeUndefined();
      expect(step.headers['cache-control']).toBe('no-store');
      expect(step.body).toEqual({
        code: 'second-factor-required',
        challengeToken: expect.stringMatching(/^mc1_/) as unknown,
        expiresAt: expect.any(String) as unknown,
      });
      const challengeToken = (step.body as { challengeToken: string }).challengeToken;

      const wrong = await post('sign-in/second-factor', code, { challengeToken, code: '000000' });
      expect(wrong.body).toEqual({ statusCode: 400, code: 'second-factor.invalid' });

      const done = await post('sign-in/second-factor', code, {
        challengeToken,
        code: codeFor(enrol.secret),
      });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ code: 'signed-in', sellerAccess: 'approved' });
      // No Max-Age: the default seller session ends with the browser (6.1).
      expect((done.headers['set-cookie'] as unknown as string[])[0]).toMatch(
        new RegExp(
          `^__Host-session-seller-${code}=ms1_[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax$`,
        ),
      );
      const summary = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie: cookieOf(done.headers['set-cookie']) });
      expect(summary.body).toMatchObject({ population: 'seller', secondFactorActive: true });

      // The same time step is never accepted twice, and a challenge is single use.
      const replay = await post('sign-in/second-factor', code, {
        challengeToken,
        code: codeFor(enrol.secret),
      });
      expect(replay.body).toEqual({ statusCode: 400, code: 'challenge.rejected' });
    });

    it('refuses an enrolment with a wrong password and over an active factor', async () => {
      await boot();
      const session = await signedUpSeller(code);
      const headers = { cookie: session.cookie, 'x-csrf-token': session.csrf };

      const wrong = await post(
        'second-factor/enrolment',
        code,
        { password: 'not the password' },
        headers,
      );
      expect(wrong.body).toEqual({ statusCode: 400, code: 'password.current-incorrect' });
      expect(fakes.factors.size).toBe(0);

      const { secret } = await enrolled(code, session);
      const again = await signedInWithFactor(code, secret);
      const over = await post('second-factor/enrolment', code, { password: PASSWORD }, again);
      expect(over.body).toEqual({ statusCode: 409, code: 'second-factor.unavailable' });
    });

    it('signs in with a recovery code once; new recovery codes replace the old ones', async () => {
      await boot();
      const session = await signedUpSeller(code);
      const { secret, recoveryCodes } = await enrolled(code, session);

      clock.advance(STEP);
      const step = await post('sign-in', code, { email: EMAIL, password: PASSWORD });
      const first = await post('sign-in/second-factor', code, {
        challengeToken: (step.body as { challengeToken: string }).challengeToken,
        code: recoveryCodes[0],
        keepSignedIn: true,
      });
      expect(first.status).toBe(200);
      // "Keep me signed in" is asked again at the code step and gives the cookie its Max-Age.
      expect((first.headers['set-cookie'] as unknown as string[])[0]).toMatch(/; Max-Age=\d+; /);
      const headers = {
        cookie: cookieOf(first.headers['set-cookie']),
        'x-csrf-token': (first.body as { csrfToken: string }).csrfToken,
      };

      clock.advance(STEP);
      const step2 = await post('sign-in', code, { email: EMAIL, password: PASSWORD });
      const reused = await post('sign-in/second-factor', code, {
        challengeToken: (step2.body as { challengeToken: string }).challengeToken,
        code: recoveryCodes[0],
      });
      expect(reused.body).toEqual({ statusCode: 400, code: 'second-factor.invalid' });

      const fresh = await post(
        'second-factor/recovery-codes',
        code,
        { code: recoveryCodes[1] },
        headers,
      );
      expect(fresh.status).toBe(200);
      expect(fresh.headers['cache-control']).toBe('no-store');
      const newCodes = (fresh.body as { recoveryCodes: string[] }).recoveryCodes;
      expect(newCodes).toHaveLength(10);
      expect(newCodes).not.toContain(recoveryCodes[2]);
      clock.advance(STEP);
      const old = await post(
        'second-factor/recovery-codes',
        code,
        { code: recoveryCodes[2] },
        headers,
      );
      expect(old.body).toEqual({ statusCode: 400, code: 'second-factor.invalid' });
      void secret;
    });

    it('removes the factor with a code: other sessions end, this one continues, the password alone signs in again', async () => {
      await boot();
      const { secret } = await enrolled(code, await signedUpSeller(code));
      const other = await signedInWithFactor(code, secret);
      const current = await signedInWithFactor(code, secret);

      clock.advance(STEP);
      const wrong = await post('second-factor/remove', code, { code: '000000' }, current);
      expect(wrong.body).toEqual({ statusCode: 400, code: 'second-factor.invalid' });
      const trace = traceCredentialOrder(fakes);
      const removed = await post('second-factor/remove', code, { code: codeFor(secret) }, current);
      trace.restore();
      expect(removed.status).toBe(200);
      // Lock order (Mojtaba S1): the account's credential lock, then the factor, then sessions.
      expect(trace.calls).toEqual(['account', 'factor', 'sessions']);
      expect(removed.body).toEqual({ code: 'second-factor-removed' });
      expect(fakes.factors.size).toBe(0);
      expect(
        fakes.events.filter((e) => e.type === 'identity.second-factor-changed.v1').at(-1)!.payload,
      ).toMatchObject({ change: 'reset' });

      const ended = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie: other.cookie });
      expect(ended.body).toEqual({ statusCode: 401, code: 'session.invalid' });
      const still = await http()
        .get('/identity/seller/session')
        .set({ 'x-market-id': code, cookie: current.cookie });
      expect(still.status).toBe(200);
      expect(still.body).toMatchObject({ secondFactorActive: false });
      // The Market's anonymous HTTP limit is spent; the password step runs through the use case.
      const signedIn = await app
        .get(SignInSeller)
        .execute(
          testCallContext(
            testMarketContext(code, PLATFORM_TENANT_ID),
            'anonymous',
            'seller-2fa-0002',
          ),
          {
            email: EMAIL,
            password: PASSWORD,
            keepSignedIn: false,
            client: { origin: '203.0.113.7', address: '203.0.113.7' },
          },
        );
      expect(signedIn).toMatchObject({ ok: true, value: { code: 'signed-in' } });
    });

    it('confirms a code through the facade: counted, spent once, no other effect, refused without a factor', async () => {
      await boot();
      const facade = app.get<IdentityFacade>(IDENTITY_FACADE);
      const first = await signedUpSeller(code);
      const sessionOf = async (headers: { cookie: string }) =>
        (
          await http()
            .get('/identity/seller/session')
            .set({ 'x-market-id': code, cookie: headers.cookie })
        ).body as { accountId: string; sellerId: string };
      const me = await sessionOf(first);
      const market = testMarketContext(code, PLATFORM_TENANT_ID);
      const context = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: me.accountId as Id<'Account'>,
          sessionId: [...fakes.sessions.keys()].at(-1)! as Id<'Session'>,
          sellerId: me.sellerId as Id<'Seller'>,
        }),
        'seller-2fa-confirm',
      );

      expect((await facade.describeActor(context)).ok).toBe(true);
      expect(await facade.describeActor(context)).toMatchObject({
        value: { secondFactorActive: false },
      });
      expect(await facade.confirmSecondFactor(context, '123456')).toEqual({
        ok: false,
        error: { code: 'second-factor.unavailable' },
      });

      const { secret, recoveryCodes } = await enrolled(code, first);
      expect(await facade.describeActor(context)).toMatchObject({
        value: { secondFactorActive: true },
      });
      const factors = [...fakes.factors.values()].length;
      clock.advance(STEP);
      expect(await facade.confirmSecondFactor(context, '000000')).toEqual({
        ok: false,
        error: { code: 'second-factor.invalid' },
      });
      expect(await facade.confirmSecondFactor(context, 'not a code')).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      const right = codeFor(secret);
      expect(await facade.confirmSecondFactor(context, right)).toEqual({
        ok: true,
        value: undefined,
      });
      // A time step is accepted once.
      expect(await facade.confirmSecondFactor(context, right)).toEqual({
        ok: false,
        error: { code: 'second-factor.invalid' },
      });
      // A recovery code works once; the factor itself is untouched.
      expect(await facade.confirmSecondFactor(context, recoveryCodes[0]!)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await facade.confirmSecondFactor(context, recoveryCodes[0]!)).toMatchObject({
        ok: false,
        error: { code: 'second-factor.invalid' },
      });
      expect([...fakes.factors.values()].length).toBe(factors);
      expect(await facade.describeActor(context)).toMatchObject({
        value: { secondFactorActive: true },
      });
    });

    it('tells the account state only after the code: a suspended seller reads 400 until the code is right', async () => {
      await boot();
      const session = await signedUpSeller(code);
      const { secret } = await enrolled(code, session);
      const [seller] = [...fakes.sellerAccess.values()];
      fakes.seedSellerAccess({ ...seller!, state: 'suspended' });

      clock.advance(STEP);
      const step = await post('sign-in', code, { email: EMAIL, password: PASSWORD });
      // The password alone does not tell that the seller is suspended.
      expect(step.body).toMatchObject({ code: 'second-factor-required' });
      const challengeToken = (step.body as { challengeToken: string }).challengeToken;
      const wrong = await post('sign-in/second-factor', code, { challengeToken, code: '000000' });
      expect(wrong.body).toEqual({ statusCode: 400, code: 'second-factor.invalid' });

      const right = await post('sign-in/second-factor', code, {
        challengeToken,
        code: codeFor(secret),
      });
      expect(right.body).toEqual({ statusCode: 403, code: 'seller-access.suspended' });
      expect(right.headers['set-cookie']).toBeUndefined();
    });

    it('binds a seller challenge to the seller population and spends a code step once', async () => {
      await boot();
      const session = await signedUpSeller(code);
      const { secret } = await enrolled(code, session);
      clock.advance(STEP);
      const step = await post('sign-in', code, { email: EMAIL, password: PASSWORD });
      const { challengeToken } = step.body as { challengeToken: string };
      clock.advance(STEP);
      const codeNow = codeFor(secret);

      // The admin code step never accepts a seller challenge.
      const crossed = await http()
        .post('/identity/admin/second-factor')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') })
        .send({ challengeToken, code: codeNow });
      expect(crossed.status).toBe(400);
      expect(crossed.headers['set-cookie']).toBeUndefined();

      const done = await post('sign-in/second-factor', code, { challengeToken, code: codeNow });
      expect(done.status).toBe(200);

      // The same time step cannot open a second session.
      const again = await post('sign-in', code, { email: EMAIL, password: PASSWORD });
      const replay = await post('sign-in/second-factor', code, {
        challengeToken: (again.body as { challengeToken: string }).challengeToken,
        code: codeNow,
      });
      expect(replay.status).toBe(400);
      expect(replay.headers['set-cookie']).toBeUndefined();
    });

    it('refuses a malformed code step body and an enrolment without a session', async () => {
      await boot();

      const missing = await post('sign-in/second-factor', code, { code: '123456' });
      const keep = await post('sign-in/second-factor', code, {
        challengeToken: 'x',
        code: '123456',
        keepSignedIn: 'yes',
      });
      const anonymous = await post('second-factor/enrolment', code, { password: PASSWORD });

      expect(missing.status).toBe(400);
      expect(keep.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'keepSignedIn', code: 'type' }] },
      });
      expect(anonymous.status).toBe(401);
    });
  });

  it('a seller waiting for approval cannot enrol (the limited session)', async () => {
    await boot();
    await app.get(SeedRoles).execute(systemOf('AU'), {});
    await post('sign-up', 'AU', { displayName: NAME, email: EMAIL, password: PASSWORD });
    const event = fakes.events
      .filter((e) => e.type === 'identity.one-time-link-requested.v1')
      .at(-1)!;
    const payload = event.payload as { linkId: Id; accountId: Id };
    await app.get(SendLinkMail).execute(systemOf('AU'), {
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
    const token = /#(ml1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
    const confirmed = await post('confirm-email', 'AU', { token, password: PASSWORD });
    expect(confirmed.body).toMatchObject({ sellerAccess: 'pending' });

    const refused = await post(
      'second-factor/enrolment',
      'AU',
      { password: PASSWORD },
      {
        cookie: cookieOf(confirmed.headers['set-cookie']),
        'x-csrf-token': (confirmed.body as { csrfToken: string }).csrfToken,
      },
    );

    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toBe('access.seller-not-approved');
    expect(fakes.factors.size).toBe(0);
  });
});
