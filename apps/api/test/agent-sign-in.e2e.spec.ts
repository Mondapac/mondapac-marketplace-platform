import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  HANDOVER_CODES,
  type HandoverCodes,
} from '../src/modules/identity/application/ports/handover-codes';
import {
  INVITATION_TOKENS,
  type OpaqueTokens,
} from '../src/modules/identity/application/ports/second-factor-tokens';
import { decodeBase32Secret } from '../src/modules/identity/domain/otpauth';
import { parseEmailAddress } from '../src/modules/identity/domain/email-address';
import { Invitation } from '../src/modules/identity/domain/invitation';
import { TOTP } from '../src/modules/identity/domain/totp';
import { hotp } from '../src/modules/identity/infrastructure/second-factor/totp';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// ADR-0045 over HTTP, for both Market fixtures: the one-request acceptance (opens no session),
// agent sign-in (a password alone never opens a session; equal answer for an unknown address),
// the agent cookie, and the population walls: an agent session on an admin route and the other
// way. The real guards, controllers and use cases; identity's stores and the mail as fakes.

const START = Temporal.Instant.from('2026-11-06T10:00:00Z');
const EMAIL = 'Agent.One@Example.com';
const PASSWORD = 'correct horse battery staple';
const STEP = Temporal.Duration.from({ seconds: TOTP.periodSeconds });
const HANDOVER = 'ABCDE-23456';

const fakes = new IdentityFakes();
let clock: FixedClock;

const cookieOf = (setCookie: unknown): string => {
  const [line] = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return line!;
};

describe.each(TEST_MARKETS)('agent routes over HTTP in market %s (ADR-0045)', (code) => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    http()
      .post(`/identity/agent/${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'agent'), ...headers })
      .send(body as object);
  const codeFor = (secret: string) =>
    hotp(
      decodeBase32Secret(secret)!,
      Math.floor(clock.now().epochMilliseconds / 1000 / TOTP.periodSeconds),
    );

  /** A pending agent invitation with the known handover code, dispatched; answers its token. */
  function invite(): { token: string; invitationId: Id<'Invitation'> } {
    const market = testMarketContext(code, PLATFORM_TENANT_ID);
    const codes = app.get<HandoverCodes>(HANDOVER_CODES, { strict: false });
    const tokens = app.get<OpaqueTokens>(INVITATION_TOKENS, { strict: false });
    const email = parseEmailAddress(EMAIL);
    if (!email.ok) throw new Error('fixture address');
    const id = '01990000-0000-7000-8000-00000000d001' as Id<'Invitation'>;
    const invitation = Invitation.issueAgent({
      id,
      marketId: market.marketId,
      email: email.value,
      displayName: 'Agent One',
      agentAccountId: '01990000-0000-7000-8000-00000000d002' as Id<'Account'>,
      handoverCodeHmac: codes.hmacOf(market, id, HANDOVER.replace('-', '')),
      invitedByAccountId: '01990000-0000-7000-8000-00000000d003' as Id<'Account'>,
      now: START,
    });
    const minted = tokens.issue();
    fakes.invitations.set(id, {
      ...invitation.state,
      tokenHash: minted.tokenHash,
      expiresAt: START.add({ hours: 24 }),
      version: invitation.state.version + 1,
    });
    return { token: minted.token, invitationId: id };
  }

  async function accepted(): Promise<{ secret: string }> {
    const { token } = invite();
    const ready = await post('invitation/enrolment', { token });
    expect(ready.status).toBe(200);
    const enrol = ready.body as { secret: string; tag: string; expiresAt: string };
    const done = await post('invitation/accept', {
      token,
      handoverCode: HANDOVER,
      password: PASSWORD,
      secret: enrol.secret,
      tag: enrol.tag,
      expiresAt: enrol.expiresAt,
      code: codeFor(enrol.secret),
    });
    expect(done.status).toBe(200);
    return { secret: enrol.secret };
  }

  beforeEach(async () => {
    fakes.reset();
    clock = new FixedClock(START);
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'silent' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  it('accepts in one request without opening a session, then signs in with a code', async () => {
    const { secret } = await accepted();
    expect(fakes.sessions.size).toBe(0);
    expect([...fakes.accounts.values()].map((a) => a.population)).toContain('agent');
    expect(fakes.audits.map((a) => a.action)).toContain('identity.agent-invitation.accepted');

    clock.advance(STEP);
    const step = await post('sign-in', { email: EMAIL, password: PASSWORD });
    expect(step.status).toBe(200);
    expect(step.body).toMatchObject({ code: 'second-factor-required' });
    expect(fakes.sessions.size).toBe(0);

    const signedIn = await post('second-factor', {
      challengeToken: (step.body as { challengeToken: string }).challengeToken,
      code: codeFor(secret),
    });
    expect(signedIn.status).toBe(200);
    const cookie = cookieOf(signedIn.headers['set-cookie']);
    expect(cookie.startsWith(`__Host-session-agent-${code}=`)).toBe(true);
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toMatch(/Max-Age|Expires/i);
    expect(fakes.audits.map((a) => a.action)).toContain('identity.agent-session.opened');

    const pair = cookie.split(';', 1)[0]!;
    const session = await http()
      .get('/identity/agent/session')
      .set({ 'x-market-id': code, cookie: pair });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ population: 'agent', displayName: 'Agent One' });
    expect(session.body).not.toHaveProperty('permissionKeys');

    // The walls: the agent cookie is no admin or seller session.
    for (const path of ['/identity/admin/session', '/identity/seller/session']) {
      const wrong = await http().get(path).set({ 'x-market-id': code, cookie: pair });
      expect([401, 403]).toContain(wrong.status);
    }

    const out = await http()
      .post('/identity/agent/sign-out')
      .set({
        'x-market-id': code,
        cookie: pair,
        ...panelHeaders(code, 'agent'),
        'x-csrf-token': (session.body as { csrfToken: string }).csrfToken,
      })
      .send({});
    expect(out.status).toBe(200);
    const after = await http()
      .get('/identity/agent/session')
      .set({ 'x-market-id': code, cookie: pair });
    expect(after.status).toBe(401);
  });

  it('refuses a wrong handover code, creates no account, and voids the code at the fifth failure', async () => {
    const { token } = invite();
    const ready = await post('invitation/enrolment', { token });
    const enrol = ready.body as { secret: string; tag: string; expiresAt: string };
    const attempt = (handoverCode: string) =>
      post('invitation/accept', {
        token,
        handoverCode,
        password: PASSWORD,
        secret: enrol.secret,
        tag: enrol.tag,
        expiresAt: enrol.expiresAt,
        code: codeFor(enrol.secret),
      });

    for (let i = 0; i < 5; i += 1) {
      const wrong = await attempt('ZZZZZ-ZZZZZ');
      expect(wrong.status).toBe(400);
    }
    expect([...fakes.accounts.values()].some((a) => a.population === 'agent')).toBe(false);
    // The code is void now: even the right one is refused.
    const right = await attempt(HANDOVER);
    expect(right.status).toBe(400);
    expect([...fakes.accounts.values()].some((a) => a.population === 'agent')).toBe(false);
  });

  it('answers an unknown address and a wrong password alike', async () => {
    await accepted();
    clock.advance(STEP);
    const unknown = await post('sign-in', { email: 'nobody@example.com', password: PASSWORD });
    const wrong = await post('sign-in', { email: EMAIL, password: 'not the password at all' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(fakes.sessions.size).toBe(0);
  });

  it('refuses an agent route to an unsafe request from another origin', async () => {
    const res = await http()
      .post('/identity/agent/sign-in')
      .set({ 'x-market-id': code, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(403);
  });
});
