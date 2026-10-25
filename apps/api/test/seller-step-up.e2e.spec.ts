import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import { decodeBase32Secret } from '../src/modules/identity/domain/otpauth';
import { TOTP } from '../src/modules/identity/domain/totp';
import { hotp } from '../src/modules/identity/infrastructure/second-factor/totp';
import { StoreSettingsSaveMinimumOrder } from '../src/modules/sellers/application/use-cases/store-settings-save-minimum-order.use-case';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller's per-action two-step rules over HTTP (seller OTP policy): the real guards, use cases
// and controllers with identity's database ports as in-memory fakes, a real seller who enrols a
// real authenticator secret. The guarded route is the minimum order of the store settings (its
// use case is a recording stub: the point here is the guard, the rule and the proof). The
// PostgreSQL side is in test/db/step-up-policy.db-spec.ts.

const START = Temporal.Instant.from('2026-10-16T10:00:00Z');
const STEP = Temporal.Duration.from({ seconds: TOTP.periodSeconds });
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Owner@Example.com';
const NAME = 'Amina Rahman';
const ACTION = 'sellers.store-terms.change';
const fakes = new IdentityFakes();
let clock: FixedClock;

const cookieOf = (setCookie: unknown): string => {
  const [line] = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return line!.split(';', 1)[0]!;
};

describe.each(TEST_MARKETS)('seller two-step rules per action in market %s', (code) => {
  let app: NestExpressApplication;
  let saves: unknown[];
  const http = () => request(app.getHttpServer());
  const base = () => ({ 'x-market-id': code, ...panelHeaders(code, 'seller') });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    http()
      .post(`/identity/seller/${path}`)
      .set({ ...base(), ...headers })
      .send(body as object);
  const systemOf = () =>
    testCallContext(testMarketContext(code, PLATFORM_TENANT_ID), 'system', 'step-up-e2e-0001');
  const codeFor = (secret: string) =>
    hotp(
      decodeBase32Secret(secret)!,
      Math.floor(clock.now().epochMilliseconds / 1000 / TOTP.periodSeconds),
    );

  /** Signs up an approved seller owner with an enrolled authenticator, signed in with the code. */
  async function ownerWithFactor() {
    await app.get(SeedRoles).execute(systemOf(), {});
    await post('sign-up', { displayName: NAME, email: EMAIL, password: PASSWORD }).expect(202);
    const event = fakes.events
      .filter((e) => e.type === 'identity.one-time-link-requested.v1')
      .at(-1)!;
    const payload = event.payload as { linkId: Id; accountId: Id };
    await app.get(SendLinkMail).execute(systemOf(), {
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
    const confirmed = await post('confirm-email', { token, password: PASSWORD }).expect(200);
    const [seller] = [...fakes.sellerAccess.values()];
    fakes.seedSellerAccess({ ...seller!, state: 'approved' });
    const first = {
      cookie: cookieOf(confirmed.headers['set-cookie']),
      'x-csrf-token': (confirmed.body as { csrfToken: string }).csrfToken,
    };
    const started = await post('second-factor/enrolment', { password: PASSWORD }, first).expect(
      200,
    );
    const enrol = started.body as { challengeToken: string; secret: string };
    clock.advance(STEP);
    await post('second-factor/enrolment/confirm', {
      challengeToken: enrol.challengeToken,
      code: codeFor(enrol.secret),
    }).expect(200);
    clock.advance(STEP);
    const step = await post('sign-in', { email: EMAIL, password: PASSWORD }).expect(200);
    clock.advance(STEP);
    const done = await post('sign-in/second-factor', {
      challengeToken: (step.body as { challengeToken: string }).challengeToken,
      code: codeFor(enrol.secret),
    }).expect(200);
    return {
      secret: enrol.secret,
      headers: {
        cookie: cookieOf(done.headers['set-cookie']),
        'x-csrf-token': (done.body as { csrfToken: string }).csrfToken,
      },
    };
  }

  const policy = (headers: Record<string, string>) =>
    http()
      .get('/identity/seller/step-up/policy')
      .set({ ...base(), ...headers });
  const guarded = (headers: Record<string, string>) =>
    http()
      .put('/sellers/store-settings/minimum-order')
      .set({ ...base(), ...headers })
      .send({ expectedVersion: 1, minimumOrder: null });
  const rowOf = (body: unknown, key: string) =>
    (body as { items: { actionKey: string }[] }).items.find((item) => item.actionKey === key);

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
          .overrideProvider(StoreSettingsSaveMinimumOrder)
          .useValue({
            execute: (_context: unknown, input: unknown) => {
              saves.push(input);
              return Promise.resolve(
                ok({
                  version: 2,
                  minimumOrder: null,
                  currency: 'AUD',
                  maximumAmount: 1n,
                  delivery: null,
                }),
              );
            },
          }),
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  it('lists every registered action with its floor, default and effective value; no-store', async () => {
    const { headers } = await ownerWithFactor();

    const res = await policy(headers);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(
      (res.body as { items: unknown[] }).items.map((i) => (i as { actionKey: string }).actionKey),
    ).toEqual([
      'catalog.offer.delete',
      'identity.second-factor.manage',
      'identity.team.change-role',
      'identity.team.invite-remove',
      'payments.payout-account.change',
      'pricing.price.change',
      'sellers.store-terms.change',
    ]);
    expect(rowOf(res.body, 'payments.payout-account.change')).toEqual({
      actionKey: 'payments.payout-account.change',
      required: true,
      locked: true,
      defaultRequired: true,
      updatedAt: null,
    });
    expect(rowOf(res.body, ACTION)).toMatchObject({ required: false, locked: false });
    expect(rowOf(res.body, 'identity.team.invite-remove')).toMatchObject({
      required: true,
      locked: false,
    });
  });

  it('refuses a visitor and a missing CSRF token', async () => {
    const { headers } = await ownerWithFactor();

    expect((await http().get('/identity/seller/step-up/policy').set(base())).status).toBe(401);
    const noToken = await post(
      'step-up/policy',
      { actionKey: ACTION, required: true, code: '123456' },
      { ...headers, 'x-csrf-token': '' },
    );
    expect(noToken.body).toEqual({ statusCode: 403, code: 'request.csrf' });
  });

  it('guards the team invitation by default: refused without a code, open for five minutes after one', async () => {
    const { headers, secret } = await ownerWithFactor();
    const invite = () =>
      http()
        .post('/identity/seller/team/invitations')
        .set({ ...base(), ...headers })
        .send({ email: 'new.member@example.com', roleId: '0199dddd-0000-7000-8000-000000000001' });
    const refused = await invite();
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'identity.team.invite-remove' },
    });
    clock.advance(STEP);
    await post(
      'step-up/verify',
      { actionKey: 'identity.team.invite-remove', code: codeFor(secret) },
      headers,
    ).expect(200);
    expect((await invite()).status).not.toBe(403);
  });

  it('lets an unguarded action through, then guards it once the Owner turns the rule on', async () => {
    const { headers, secret } = await ownerWithFactor();
    expect((await guarded(headers)).status).toBe(200);

    clock.advance(STEP);
    const wrong = await post(
      'step-up/policy',
      { actionKey: ACTION, required: true, code: '000000' },
      headers,
    );
    expect(wrong.body).toEqual({ statusCode: 400, code: 'second-factor.invalid' });

    const set = await post(
      'step-up/policy',
      { actionKey: ACTION, required: true, code: codeFor(secret) },
      headers,
    );
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      code: 'step-up-policy.changed',
      actionKey: ACTION,
      required: true,
    });
    expect(rowOf((await policy(headers)).body, ACTION)).toMatchObject({ required: true });
    expect(fakes.audits.map((a) => a.action)).toContain('identity.seller-step-up-policy.changed');
    expect(fakes.audits.at(-1)).toMatchObject({
      action: 'identity.seller-step-up-policy.changed',
      before: { actionKey: ACTION, required: false },
      after: { actionKey: ACTION, required: true },
    });

    const refused = await guarded(headers);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: ACTION },
    });
    expect(saves).toHaveLength(1);
  });

  it('accepts the action after a code for that action, for five minutes, and for no other action', async () => {
    const { headers, secret } = await ownerWithFactor();
    clock.advance(STEP);
    await post(
      'step-up/policy',
      { actionKey: ACTION, required: true, code: codeFor(secret) },
      headers,
    ).expect(200);
    await post(
      'step-up/policy',
      {
        actionKey: 'pricing.price.change',
        required: true,
        code: (clock.advance(STEP), codeFor(secret)),
      },
      headers,
    ).expect(200);

    clock.advance(STEP);
    const verified = await post(
      'step-up/verify',
      { actionKey: ACTION, code: codeFor(secret) },
      headers,
    );
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ code: 'step-up-verified', actionKey: ACTION });
    expect(verified.headers['cache-control']).toBe('no-store');

    expect((await guarded(headers)).status).toBe(200);
    // The proof covers one action only.
    const other = await http()
      .put(
        '/pricing/seller/offers/01990000-0000-7000-8000-000000000001/variants/01990000-0000-7000-8000-000000000002/regular-price',
      )
      .set({ ...base(), ...headers })
      .send({});
    expect(other.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'pricing.price.change' },
    });
    // Within five minutes, still covered; after five, asked again.
    clock.advance(Temporal.Duration.from({ minutes: 4 }));
    expect((await guarded(headers)).status).toBe(200);
    clock.advance(Temporal.Duration.from({ minutes: 2 }));
    expect((await guarded(headers)).status).toBe(403);
  });

  it('answers a repeated code, an unknown action and a locked action with the right codes', async () => {
    const { headers, secret } = await ownerWithFactor();
    clock.advance(STEP);
    const first = codeFor(secret);
    await post('step-up/verify', { actionKey: ACTION, code: first }, headers).expect(200);

    const replay = await post('step-up/verify', { actionKey: ACTION, code: first }, headers);
    expect(replay.body).toEqual({ statusCode: 400, code: 'second-factor.invalid' });
    const unknown = await post(
      'step-up/verify',
      { actionKey: 'nope.nothing', code: first },
      headers,
    );
    expect(unknown.body).toEqual({ statusCode: 404, code: 'step-up.action-unknown' });

    clock.advance(STEP);
    const locked = await post(
      'step-up/policy',
      { actionKey: 'identity.team.change-role', required: false, code: codeFor(secret) },
      headers,
    );
    expect(locked.body).toEqual({ statusCode: 409, code: 'step-up.locked' });
  });

  it('answers a rule that changes nothing without spending a code, and checks the body', async () => {
    const { headers } = await ownerWithFactor();

    const same = await post(
      'step-up/policy',
      { actionKey: ACTION, required: false, code: '000000' },
      headers,
    );
    expect(same.body).toEqual({
      code: 'step-up-policy.unchanged',
      actionKey: ACTION,
      required: false,
    });
    const bad = await post(
      'step-up/policy',
      { actionKey: ACTION, required: 'yes', code: '000000' },
      headers,
    );
    expect(bad.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'required', code: 'type' }] },
    });
    const extra = await post(
      'step-up/policy',
      { actionKey: ACTION, required: true, code: '000000', sellerId: 'x' },
      headers,
    );
    expect(extra.status).toBe(400);
  });
});
