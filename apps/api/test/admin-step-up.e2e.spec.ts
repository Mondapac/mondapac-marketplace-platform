import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { AcceptAdminInvitation } from '../src/modules/identity/application/use-cases/accept-admin-invitation.use-case';
import { CompleteAdminSignIn } from '../src/modules/identity/application/use-cases/complete-admin-sign-in.use-case';
import { IssueFirstAdminInvitation } from '../src/modules/identity/application/use-cases/issue-first-admin-invitation.use-case';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendInvitationMail } from '../src/modules/identity/application/use-cases/send-invitation-mail.use-case';
import { SignInAdmin } from '../src/modules/identity/application/use-cases/sign-in-admin.use-case';
import { StartAdminInvitationAcceptance } from '../src/modules/identity/application/use-cases/start-admin-invitation-acceptance.use-case';
import { VerifyAdminStepUp } from '../src/modules/identity/application/use-cases/verify-admin-step-up.use-case';
import { decodeBase32Secret } from '../src/modules/identity/domain/otpauth';
import { TOTP } from '../src/modules/identity/domain/totp';
import { hotp } from '../src/modules/identity/infrastructure/second-factor/totp';
import { SetWalletStatus } from '../src/modules/wallet/application/use-cases/set-wallet-status.use-case';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { AUTHENTICATOR, type Authenticator } from '../src/platform/authz/authenticator';
import { CLOCK } from '../src/platform/clock/clock.module';
import { loadMarketConfigs } from '../src/platform/market-config/market-config';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import {
  panelHeaders,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
  testMarketId,
} from './support/test-config';

// The admin step-up over HTTP (issue #491): the real guards, controllers and identity use cases,
// with identity's database ports as in-memory fakes, a real admin who accepted the first-admin
// invitation with a real authenticator secret, and a fixed clock. The guarded route is
// `PUT /wallet/admin/settings`; its use case is a recording stub here (the point is the guard,
// the proof and the verify route; the use case's own check and the PostgreSQL side are in
// test/db/admin-step-up.db-spec.ts). Each case sends only the requests it is about over HTTP
// (the anonymous identity limit of ZZ is 10 a minute) and prepares the rest through use cases.

const START = Temporal.Instant.from('2026-10-25T10:00:00Z');
const EMAIL = 'Root.Admin@Example.com';
const PASSWORD = 'correct horse battery staple';
const CLIENT = { origin: '203.0.113.7', address: '203.0.113.7' };
const STEP = Temporal.Duration.from({ seconds: TOTP.periodSeconds });
const ACTION = 'wallet.settings.change';
const MARKETS = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

const fakes = new IdentityFakes();
let clock: FixedClock;
let deliveries = 0;

describe.each(TEST_MARKETS)('the admin step-up over HTTP in market %s', (code) => {
  let app: NestExpressApplication;
  let saves: unknown[];
  const http = () => request(app.getHttpServer());
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const systemOf = () => testCallContext(market, 'system', 'admin-step-up-e2e-0001');
  const anonymousOf = () => testCallContext(market, 'anonymous', 'admin-step-up-e2e-0002');
  const codeFor = (secret: string) =>
    hotp(
      decodeBase32Secret(secret)!,
      Math.floor(clock.now().epochMilliseconds / 1000 / TOTP.periodSeconds),
    );
  const headers = () => ({ 'x-market-id': code, ...panelHeaders(code, 'admin') });

  /** The first admin of the Market, with an active factor: answers the app's secret. */
  async function acceptedAdmin(): Promise<string> {
    await app.get(SeedRoles).execute(systemOf(), {});
    const issued = await app.get(IssueFirstAdminInvitation).execute(systemOf(), { email: EMAIL });
    expect(issued.ok).toBe(true);
    const event = fakes.events.filter((e) => e.type === 'identity.invitation-issued.v1').at(-1)!;
    await app.get(SendInvitationMail).execute(systemOf(), {
      delivery: {
        eventId: `0199ffff-0000-7000-8000-${String(++deliveries).padStart(12, '0')}` as Id<'event'>,
        subscriber: 'identity.invitation-mail',
        attempt: 1,
      },
      invitationId: (event.payload as { invitationId: Id }).invitationId,
      aggregateVersion: event.aggregateVersion,
    });
    const token = /#(mi1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
    const ready = await app
      .get(StartAdminInvitationAcceptance)
      .execute(anonymousOf(), { token, client: CLIENT });
    if (!ready.ok) throw new Error(ready.error.code);
    const accepted = await app.get(AcceptAdminInvitation).execute(anonymousOf(), {
      token,
      displayName: 'Maryam Haddad',
      password: PASSWORD,
      secret: ready.value.secret,
      tag: ready.value.tag,
      expiresAt: ready.value.expiresAt.toString(),
      code: codeFor(ready.value.secret),
      client: CLIENT,
    });
    if (!accepted.ok) throw new Error(accepted.error.code);
    return ready.value.secret;
  }

  /** Signs the admin in through both steps; answers the session's cookie and CSRF headers. */
  async function signedIn(secret: string): Promise<Record<string, string>> {
    clock.advance(STEP);
    const step = await app
      .get(SignInAdmin)
      .execute(anonymousOf(), { email: EMAIL, password: PASSWORD, client: CLIENT });
    if (!step.ok || step.value.code !== 'second-factor-required') throw new Error('no challenge');
    const done = await app.get(CompleteAdminSignIn).execute(anonymousOf(), {
      challengeToken: step.value.challengeToken,
      code: codeFor(secret),
      client: CLIENT,
    });
    if (!done.ok) throw new Error(done.error.code);
    return {
      cookie: `__Host-session-admin-${code}=${done.value.token}`,
      'x-csrf-token': csrfTokenFor(done.value.token),
    };
  }

  const verify = (session: Record<string, string>, body: unknown) =>
    http()
      .post('/identity/admin/step-up/verify')
      .set({ ...headers(), ...session })
      .send(body as object);
  const turnOn = (session: Record<string, string>) =>
    http()
      .put('/wallet/admin/settings')
      .set({ ...headers(), ...session })
      .send({ status: 'active' });

  beforeEach(async () => {
    fakes.reset();
    clock = new FixedClock(START);
    saves = [];
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(SetWalletStatus)
          .useValue({
            execute: (_context: unknown, input: unknown) => {
              saves.push(input);
              return Promise.resolve(ok({ status: 'active', reason: null, updatedAt: START }));
            },
          }),
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  it('refuses the wallet switch without a proof, opens it for five minutes after a code, audited', async () => {
    const secret = await acceptedAdmin();
    const session = await signedIn(secret);

    const refused = await turnOn(session);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: ACTION },
    });
    expect(saves).toEqual([]);

    clock.advance(STEP);
    const verified = await verify(session, { actionKey: ACTION, code: codeFor(secret) });
    expect(verified.status).toBe(200);
    expect(verified.headers['cache-control']).toBe('no-store');
    expect(verified.body).toEqual({ code: 'step-up-verified', actionKey: ACTION });
    const account = [...fakes.accounts.values()].find((a) => a.population === 'admin')!;
    expect(
      fakes.audits
        .filter((a) => a.action === 'identity.admin-step-up.verified')
        .map((a) => [a.targetId, (a.after as { actionKey: string }).actionKey]),
    ).toEqual([[account.id, ACTION]]);

    clock.advance(Temporal.Duration.from({ minutes: 4, seconds: 59 }));
    expect((await turnOn(session)).status).toBe(200);
    expect(saves).toEqual([{ status: 'active' }]);

    clock.advance(Temporal.Duration.from({ seconds: 1 }));
    expect((await turnOn(session)).body).toMatchObject({ code: 'second-factor.required' });
    expect(saves).toHaveLength(1);
  });

  it('does not let a proof of one session cover another session', async () => {
    const secret = await acceptedAdmin();
    const first = await signedIn(secret);
    const second = await signedIn(secret);

    clock.advance(STEP);
    expect((await verify(first, { actionKey: ACTION, code: codeFor(secret) })).status).toBe(200);

    expect((await turnOn(second)).body).toMatchObject({
      code: 'second-factor.required',
      details: { actionKey: ACTION },
    });
    expect((await turnOn(first)).status).toBe(200);
  });

  it('refuses a wrong code, a seller action, an unknown key and a missing CSRF token', async () => {
    const secret = await acceptedAdmin();
    const session = await signedIn(secret);

    const wrong = await verify(session, { actionKey: ACTION, code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ code: 'second-factor.invalid' });
    for (const actionKey of ['pricing.price.change', 'wallet.settings.unknown']) {
      const unknown = await verify(session, { actionKey, code: '000000' });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ code: 'step-up.action-unknown' });
    }
    const noToken = await verify(
      { cookie: session.cookie! },
      { actionKey: ACTION, code: codeFor(secret) },
    );
    expect(noToken.body).toEqual({ statusCode: 403, code: 'request.csrf' });
    expect((await turnOn(session)).status).toBe(403);
    expect(fakes.audits.filter((a) => a.action === 'identity.admin-step-up.verified')).toEqual([]);
  });

  it('refuses the code the admin just signed in with, within the same time step', async () => {
    const secret = await acceptedAdmin();
    const session = await signedIn(secret);

    // signedIn spent the code of this step; the clock has not moved.
    const replay = await verify(session, { actionKey: ACTION, code: codeFor(secret) });
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ code: 'second-factor.invalid' });
    expect((await turnOn(session)).status).toBe(403);
    clock.advance(STEP);
    expect((await verify(session, { actionKey: ACTION, code: codeFor(secret) })).status).toBe(200);
  });

  it('audits a wrong code as identity.admin-step-up.refused, never the code', async () => {
    const secret = await acceptedAdmin();
    const session = await signedIn(secret);

    expect((await verify(session, { actionKey: ACTION, code: '000000' })).status).toBe(400);
    const refused = fakes.audits.filter((a) => a.action === 'identity.admin-step-up.refused');
    expect(refused.map((a) => a.after)).toEqual([
      {
        sessionId: [...fakes.sessions.values()].at(-1)!.session.id,
        actionKey: ACTION,
        cause: 'invalid',
      },
    ]);
    expect(JSON.stringify(refused)).not.toContain('000000');
  });

  it('ends a proof when the factor is enrolled again after it', async () => {
    const secret = await acceptedAdmin();
    const session = await signedIn(secret);
    clock.advance(STEP);
    expect((await verify(session, { actionKey: ACTION, code: codeFor(secret) })).status).toBe(200);
    expect((await turnOn(session)).status).toBe(200);

    // A re-enrolment activates a new factor after the proof (a real reset also ends every
    // session of the account, and the proof with it; this is the check behind that).
    clock.advance(STEP);
    const account = [...fakes.accounts.values()].find((a) => a.population === 'admin')!;
    const factor = fakes.factors.get(account.id)!;
    fakes.factors.set(account.id, { ...factor, activatedAt: clock.now() });

    const refused = await turnOn(session);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'second-factor.required' });
  });

  it('refuses an acting-as session on the verify route and on the PUT', async () => {
    const secret = await acceptedAdmin();
    const session = await signedIn(secret);
    clock.advance(STEP);
    expect((await verify(session, { actionKey: ACTION, code: codeFor(secret) })).status).toBe(200);
    const proofs = new Map(fakes.stepUpProofs);
    const audits = fakes.audits.length;

    // The session as an acting-as session (Login as Seller) would present it: the reserved
    // marker on the actor. No session carries it yet (SEL-08), so the authenticator adds it.
    const authenticator = app.get<Authenticator>(AUTHENTICATOR);
    const real = authenticator.authenticate.bind(authenticator);
    const spy = jest.spyOn(authenticator, 'authenticate').mockImplementation(async (m, c) => {
      const result = await real(m, c);
      return result.ok
        ? ok({ ...result.value, actingAs: { sellerId: '01990000-0000-7000-8000-0000000000aa' } })
        : result;
    });
    try {
      clock.advance(STEP);
      const verified = await verify(session, { actionKey: ACTION, code: codeFor(secret) });
      // Today the actor guard refuses any actor that identity did not mint, which an actor with
      // the marker is not: the request never reaches a use case. RequireStepUp, VerifyAdminStepUp,
      // the consumer and setStatus refuse the marker again (unit specs), for when SEL-08 mints it.
      expect(verified.body).toEqual({ statusCode: 401, code: 'session.invalid' });
      const put = await turnOn(session);
      expect(put.body).toEqual({ statusCode: 401, code: 'session.invalid' });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(saves).toEqual([]);
    expect(fakes.stepUpProofs).toEqual(proofs);
    expect(fakes.audits.length).toBe(audits);
  });

  it('counts wrong codes on the sign-in lock-out: at the limit the factor is locked', async () => {
    const secret = await acceptedAdmin();
    const session = await signedIn(secret);
    const limit = MARKETS.get(testMarketId(code))!.identity.secondFactorThrottles!.account.limit;
    const admin = [...fakes.sessions.values()].at(-1)!.session;
    const context = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: admin.accountId,
        sessionId: admin.id,
        sellerId: null,
      }),
      'admin-step-up-e2e-0003',
    );

    let last: unknown;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      last = await app
        .get(VerifyAdminStepUp)
        .execute(context, { actionKey: ACTION, code: '000000' });
    }
    expect(last).toMatchObject({ ok: false, error: { code: 'second-factor.locked' } });

    clock.advance(STEP);
    const locked = await verify(session, { actionKey: ACTION, code: codeFor(secret) });
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({ code: 'second-factor.locked' });
    // The same lock as the admin sign-in: the password step answers it too.
    clock.advance(STEP);
    expect(
      await app
        .get(SignInAdmin)
        .execute(anonymousOf(), { email: EMAIL, password: PASSWORD, client: CLIENT }),
    ).toMatchObject({ ok: true, value: { code: 'second-factor.locked' } });
    expect((await turnOn(session)).status).toBe(403);
  });
});
