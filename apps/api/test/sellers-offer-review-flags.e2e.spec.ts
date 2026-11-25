import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { OFFER_REVIEW_FLAGS_REPOSITORY } from '../src/modules/sellers/application/ports/offer-review-flags.repository';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { InMemoryOfferReviewFlags } from './support/sellers-offer-review-flags-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin routes of a seller's Offer review flags over HTTP (SEL-25; risk-based Offer approval
// slice 4): `GET /sellers/admin/:sellerId/offer-review` and the three `PUT`s, with the real guards,
// controller, gate and use cases on both Market fixtures. Identity's database ports are in-memory
// fakes; the flags store is in memory (the SQL is test/db/offer-review-probation.db-spec.ts).

const START = Temporal.Instant.from('2026-11-25T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xb000 + n)}`);
const sellerId = (n: number) => id<'Seller'>(`01990000-0000-7000-8000-${n12(0xc000 + n)}`);
const sessionId = (n: number) => `01990000-0000-7000-8000-${n12(0xf200 + n)}`;
const ROOT = accountId(1);
const VIEWER = accountId(2);
const SELLER_ACCOUNT = accountId(6);
const CANARY = 'canary-reason-quokka';

const STEP_UP = {
  trusted: 'sellers.offer-review-trust.change',
  'full-review': null,
  stop: 'sellers.offer-review-stop.change',
} as const;

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('seller Offer review flags over HTTP (integration, slice 4)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let flags: InMemoryOfferReviewFlags;
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(OFFER_REVIEW_FLAGS_REPOSITORY)
          .useValue(flags),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const roleOf = (code: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
    )!.id;

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'acts-0001'), {});
    const marketId = code as AccountState['marketId'];
    const account = (n: number, idOf: Id<'Account'>, population: AccountState['population']) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `Person${n}@Example.com`, normalized: `person${n}@example.com` },
        displayName: `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    for (const [n, idOf, seedCode] of [
      [1, ROOT, 'platform-administrator'],
      [2, VIEWER, 'viewer'],
    ] as const) {
      account(n, idOf, 'admin');
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe200 + n)}`),
        marketId,
        accountId: idOf,
        roleId: roleOf(code, seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
      fakes.factors.set(idOf, {
        id: id<'SecondFactor'>(`01990000-0000-7000-8000-${n12(0xf300 + n)}`),
        marketId,
        accountId: idOf,
        state: 'active',
        secretCiphertext: 'sealed',
        pendingSecretCiphertext: null,
        lastAcceptedStep: null,
        activatedAt: START,
        lockedAt: null,
        createdAt: START,
        recoveryCodes: Array.from({ length: 10 }, (_, index) => ({
          position: index + 1,
          codeHash: new Uint8Array(32).fill(index + 1),
          usedAt: null,
        })),
        version: 1,
      });
    }
    account(6, SELLER_ACCOUNT, 'seller');
  }

  function sessionHeaders(
    code: string,
    account: Id<'Account'>,
    n: number,
    population: 'admin' | 'seller' = 'admin',
    { proved = true } = {},
  ) {
    const issued = tokens.issue();
    if (population === 'admin' && proved) {
      for (const action of [STEP_UP.trusted, STEP_UP.stop]) {
        fakes.stepUpProofs.set(`${code}|${sessionId(n)}|${action}`, clock.now());
      }
    }
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(sessionId(n)),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
        sellerId: population === 'seller' ? sellerId(1) : null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-${population}-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const base = (seller: string) => `/sellers/admin/${seller}/offer-review`;
  const get = (code: string, seller: string, headers: Record<string, string> | null) => {
    const call = http()
      .get(base(seller))
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    return headers === null ? call : call.set('cookie', headers.cookie!);
  };
  const put = (
    code: string,
    flag: keyof typeof STEP_UP,
    seller: string,
    headers: Record<string, string> | null,
    body: unknown,
  ) => {
    const call = http()
      .put(`${base(seller)}/${flag}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    if (headers === null) return call.send(body as object);
    return call
      .set('cookie', headers.cookie!)
      .set({ 'x-csrf-token': headers['x-csrf-token']! })
      .send(body as object);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    flags = new InMemoryOfferReviewFlags();
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the read and the three changes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.paths['/sellers/admin/{sellerId}/offer-review']).toHaveProperty('get');
    for (const flag of ['trusted', 'full-review', 'stop']) {
      expect(document.paths[`/sellers/admin/{sellerId}/offer-review/${flag}`]).toHaveProperty(
        'put',
      );
    }
    for (const schema of [
      'OfferReviewFlagRequest',
      'OfferReviewFlagChangedBody',
      'OfferReviewFlagsViewBody',
    ]) {
      expect(document.components.schemas).toHaveProperty([schema]);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const other = TEST_MARKETS.find((m) => m !== code)!;

    it.each(Object.keys(STEP_UP) as (keyof typeof STEP_UP)[])(
      'switches %s on, reads it back, never logs the reason',
      async (flag) => {
        await boot();
        await seeded(code);
        flags.seed(marketOf(code), sellerId(1));

        const changed = await put(code, flag, sellerId(1), sessionHeaders(code, ROOT, 1), {
          on: true,
          reason: CANARY,
          expectedVersion: 1,
        });
        expect(changed.status).toBe(200);
        expect(changed.headers['cache-control']).toBe('no-store');
        expect(changed.body).toEqual({ on: true, changed: true, version: 2 });

        const read = await get(code, sellerId(1), sessionHeaders(code, ROOT, 2));
        expect(read.status).toBe(200);
        const field = {
          trusted: 'trustedFromStart',
          'full-review': 'fullReview',
          stop: 'reviewStop',
        }[flag];
        expect(read.body).toMatchObject({ version: 2, [field]: { on: true } });
        expect(flags.changes).toEqual([expect.objectContaining({ reason: CANARY })]);
        expect(JSON.stringify(logLines)).not.toContain(CANARY);

        const stale = await put(code, flag, sellerId(1), sessionHeaders(code, ROOT, 3), {
          on: false,
          reason: 'x',
          expectedVersion: 1,
        });
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ code: 'conflict.stale' });
      },
    );

    it.each(['trusted', 'stop'] as const)(
      'refuses %s without a fresh two-step proof: 403 second-factor.required with the action key',
      async (flag) => {
        await boot();
        await seeded(code);
        flags.seed(marketOf(code), sellerId(1));
        const refused = await put(
          code,
          flag,
          sellerId(1),
          sessionHeaders(code, ROOT, 4, 'admin', { proved: false }),
          { on: true, reason: 'x', expectedVersion: 1 },
        );
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({
          code: 'second-factor.required',
          details: { actionKey: STEP_UP[flag] },
        });
        expect(flags.changes).toEqual([]);
      },
    );

    it('changes full review without a two-step proof', async () => {
      await boot();
      await seeded(code);
      flags.seed(marketOf(code), sellerId(1));
      const changed = await put(
        code,
        'full-review',
        sellerId(1),
        sessionHeaders(code, ROOT, 5, 'admin', { proved: false }),
        { on: true, reason: 'x', expectedVersion: 1 },
      );
      expect(changed.status).toBe(200);
    });

    it('answers validation.failed with paths and codes only', async () => {
      await boot();
      await seeded(code);
      flags.seed(marketOf(code), sellerId(1));
      const answer = await put(code, 'stop', sellerId(1), sessionHeaders(code, ROOT, 6), {
        on: true,
        reason: `${CANARY}${'x'.repeat(500)}`,
        expectedVersion: 1,
      });
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'reason', code: 'too-long' }] },
      });
      expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    });

    it('refuses a visitor, a seller session and an admin without the key', async () => {
      await boot();
      await seeded(code);
      flags.seed(marketOf(code), sellerId(1));
      const body = { on: true, reason: 'x', expectedVersion: 1 };
      expect((await put(code, 'stop', sellerId(1), null, body)).status).toBe(401);
      expect(
        (
          await put(
            code,
            'stop',
            sellerId(1),
            sessionHeaders(code, SELLER_ACCOUNT, 7, 'seller'),
            body,
          )
        ).status,
      ).toBe(401);
      for (const flag of ['trusted', 'full-review', 'stop'] as const) {
        const viewer = await put(code, flag, sellerId(1), sessionHeaders(code, VIEWER, 8), body);
        expect(viewer.status).toBe(403);
        expect(viewer.body).toMatchObject({ code: 'access.denied' });
      }
      expect(flags.changes).toEqual([]);
      // The Viewer reads the flags (sellers.seller.view).
      expect((await get(code, sellerId(1), sessionHeaders(code, VIEWER, 9))).status).toBe(200);
    });

    it("treats another Market's seller, an unknown and a malformed id as not found", async () => {
      await boot();
      await seeded(code);
      flags.seed(marketOf(other), sellerId(2));
      const body = { on: true, reason: 'x', expectedVersion: 1 };
      for (const answer of [
        await get(code, sellerId(2), sessionHeaders(code, ROOT, 10)),
        await put(code, 'full-review', sellerId(2), sessionHeaders(code, ROOT, 11), body),
        await put(code, 'full-review', sellerId(3), sessionHeaders(code, ROOT, 12), body),
        await get(code, 'not-an-id', sessionHeaders(code, ROOT, 13)),
      ]) {
        expect(answer.status).toBe(404);
        expect(answer.body).toMatchObject({ code: 'file.not-found' });
      }
      expect(flags.changes).toEqual([]);
    });
  });
});
