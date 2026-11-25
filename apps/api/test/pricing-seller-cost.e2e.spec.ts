import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { COST_SERIES_REPOSITORY } from '../src/modules/pricing/application/ports/cost-series.repository';
import { OFFER_SELL_UNITS_SOURCE } from '../src/modules/pricing/application/ports/offer-sell-units';
import { WRITE_RATE_COUNTER_REPOSITORY } from '../src/modules/pricing/application/ports/write-rate-counter.repository';
import { WRITE_REFUSAL_THROTTLE_REPOSITORY } from '../src/modules/pricing/application/ports/write-refusal-throttle.repository';
import { COST_STATUS } from '../src/modules/pricing/presentation/http/cost/seller-offer-costs.controller';
import { AUDIT_WRITER } from '../src/platform/audit/audit-writer';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { InMemoryCostSeries } from './support/pricing-cost-fakes';
import {
  FakeOfferSellUnits,
  FakeUnitOfWork,
  InMemoryRefusalThrottles,
  InMemoryWriteRateCounters,
  RecordingAuditWriter,
} from './support/pricing-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller Cost routes over HTTP (pricing slice 3; design 6.5; ux F41): the real guards,
// controller, gate and the real `pricing.view-cost` and `pricing.set-cost` use cases, with
// identity's ports and pricing's stores as in-memory fakes. Proved here: the seller session, the
// CSRF token on the write, the closed body, the status of each refusal, `no-store` on every
// answer (refusals too), that no answer or log line echoes a Cost the request did not ask to read.

const START = Temporal.Instant.from('2026-11-25T08:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const CURRENCY: Record<string, string> = { AU: 'AUD', ZZ: 'JPY' };
/** A Cost that appears only where a leak would put it. */
const CANARY = '7777123';

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const SELLER = id<'Seller'>(0xb020);
const OFFER = id<'Offer'>(0xc001);
const VARIANT = id<'Variant'>(0xc002);
const PRODUCT = id<'Product'>(0xc003);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the Cost use cases to its exact status', () => {
  expect(COST_STATUS).toEqual({
    'validation.failed': 400,
    'pricing.acting-as-refused': 403,
    'pricing.offer-not-found': 404,
    'pricing.currency-mismatch': 422,
    'pricing.amount-out-of-range': 422,
    'pricing.series-retired': 409,
    'conflict.stale': 409,
    'request.throttled': 429,
  });
});

describe('seller Cost over HTTP (integration, pricing slice 3)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let clock: FixedClock;
  let costs: InMemoryCostSeries;
  let offers: FakeOfferSellUnits;
  const http = () => request(app.getHttpServer());

  async function boot() {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(COST_SERIES_REPOSITORY)
          .useValue(costs)
          .overrideProvider(WRITE_REFUSAL_THROTTLE_REPOSITORY)
          .useValue(new InMemoryRefusalThrottles())
          .overrideProvider(WRITE_RATE_COUNTER_REPOSITORY)
          .useValue(new InMemoryWriteRateCounters())
          .overrideProvider(OFFER_SELL_UNITS_SOURCE)
          .useValue(offers)
          .overrideProvider(AUDIT_WRITER)
          .useValue(new RecordingAuditWriter()),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string, roleCode = 'seller-owner') {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'price-0001'), {});
    const marketId = code as AccountState['marketId'];
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === roleCode,
    )!.id;
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state: 'approved',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 3,
      createdAt: START,
    });
    fakes.seedAccount({
      id: OWNER,
      marketId,
      population: 'seller',
      email: { typed: 'Owner@Example.com', normalized: 'owner@example.com' },
      displayName: 'Owner',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe001),
      marketId,
      accountId: OWNER,
      roleId: ownerRole,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf001),
      marketId,
      accountId: OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
    offers.put(marketOf(code), OFFER, {
      sellerId: SELLER,
      productId: PRODUCT,
      deleted: false,
      priceableVariantIds: [VARIANT],
    });
  }

  function sessionOf(code: string) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf101),
        marketId: code as AccountState['marketId'],
        accountId: OWNER,
        population: 'seller',
        sellerId: SELLER,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-seller-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const costBody = (code: string, extra: Record<string, unknown> = {}) => ({
    cost: { amount: '1250', currency: CURRENCY[code] },
    expectedVersion: null,
    ...extra,
  });
  const put = (
    code: string,
    payload: unknown,
    headers: Record<string, string>,
    offerId: string = OFFER,
  ) =>
    http()
      .put(`/pricing/seller/offers/${offerId}/variants/${VARIANT}/cost`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers })
      .send(payload as object);
  const get = (code: string, headers: Record<string, string>, offerId: string = OFFER) =>
    http()
      .get(`/pricing/seller/offers/${offerId}/costs`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    costs = new InMemoryCostSeries();
    offers = new FakeOfferSellUnits();
  });
  afterEach(async () => {
    await app.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('reads "no cost", records one, reads it back; every answer is no-store', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const empty = await get(code, { cookie: session.cookie });
      expect(empty.status).toBe(200);
      expect(empty.headers['cache-control']).toBe('no-store');
      expect(empty.body).toEqual({
        offerId: OFFER,
        currency: CURRENCY[code],
        variants: [{ variantId: VARIANT, seriesVersion: null, cost: null }],
      });

      const written = await put(code, costBody(code), session);
      expect(written.status).toBe(200);
      expect(written.headers['cache-control']).toBe('no-store');
      expect(written.body).toEqual({ status: 'recorded', seriesVersion: 1 });
      expect(JSON.stringify(written.body)).not.toContain('1250');

      const read = await get(code, { cookie: session.cookie });
      expect(read.body).toEqual({
        offerId: OFFER,
        currency: CURRENCY[code],
        variants: [
          {
            variantId: VARIANT,
            seriesVersion: 1,
            cost: { amount: '1250', currency: CURRENCY[code] },
          },
        ],
      });

      const cleared = await put(code, { cost: null, expectedVersion: 1 }, session);
      expect(cleared.body).toEqual({ status: 'cleared', seriesVersion: 2 });
      expect(costs.records.map((record) => record.cleared)).toEqual([false, true]);
    });

    it('refuses the write without the CSRF token and without a session, storing nothing', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const noCsrf = await put(code, costBody(code), { cookie: session.cookie });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect((await put(code, costBody(code), {})).status).toBe(401);
      expect((await get(code, {})).status).toBe(401);
      expect(costs.records).toHaveLength(0);
    });

    it('answers a closed-body or format refusal with paths and codes only, no-store, never the value', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const extra = await put(code, costBody(code, { note: CANARY }), session);
      expect(extra.status).toBe(400);
      expect(extra.headers['cache-control']).toBe('no-store');
      expect(extra.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'note', code: 'unknown-field' }] },
      });
      const format = await put(
        code,
        costBody(code, { cost: { amount: `${CANARY}.5`, currency: CURRENCY[code] } }),
        session,
      );
      expect(format.status).toBe(400);
      expect(format.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'cost.amount', code: 'format' }] },
      });
      const currency = await put(
        code,
        costBody(code, { cost: { amount: CANARY, currency: 'XXX' } }),
        session,
      );
      expect(currency.status).toBe(422);
      expect(currency.body).toEqual({ statusCode: 422, code: 'pricing.currency-mismatch' });
      const zero = await put(
        code,
        costBody(code, { cost: { amount: '0', currency: CURRENCY[code] } }),
        session,
      );
      expect(zero.status).toBe(422);
      expect(zero.body).toEqual({ statusCode: 422, code: 'pricing.amount-out-of-range' });
      expect(costs.records).toHaveLength(0);
      expect(JSON.stringify(logLines)).not.toContain(CANARY);
    });

    it('answers an unknown or foreign Offer as one 404 (no-store), and a stale version as 409', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const unknown = await put(code, costBody(code), session, id<'Offer'>(0xc999));
      expect(unknown.status).toBe(404);
      expect(unknown.headers['cache-control']).toBe('no-store');
      expect(unknown.body).toEqual({ statusCode: 404, code: 'pricing.offer-not-found' });
      const unknownRead = await get(code, { cookie: session.cookie }, id<'Offer'>(0xc999));
      expect(unknownRead.status).toBe(404);
      expect(unknownRead.headers['cache-control']).toBe('no-store');

      expect((await put(code, costBody(code), session)).status).toBe(200);
      const stale = await put(code, costBody(code), session);
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({ statusCode: 409, code: 'conflict.stale' });

      offers.put(marketOf(code), OFFER, {
        sellerId: id<'Seller'>(0xb999),
        productId: PRODUCT,
        deleted: false,
        priceableVariantIds: [VARIANT],
      });
      const foreign = await get(code, { cookie: session.cookie });
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual({ statusCode: 404, code: 'pricing.offer-not-found' });
    });

    it('refuses both routes to a role without pricing.cost.view (Q11: Seller Owner only by default)', async () => {
      await boot();
      await seeded(code, 'store-manager');
      const session = sessionOf(code);

      const read = await get(code, { cookie: session.cookie });
      expect(read.status).toBe(403);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(read.body).toEqual({ statusCode: 403, code: 'access.denied' });
      const write = await put(code, costBody(code), session);
      expect(write.status).toBe(403);
      expect(costs.records).toHaveLength(0);
    });

    it('logs the route outcome by code only, never a Cost', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      await put(
        code,
        costBody(code, { cost: { amount: CANARY, currency: CURRENCY[code] } }),
        session,
      );
      await get(code, { cookie: session.cookie });
      expect(logLines.find((l) => l.msg === 'pricing.set-cost-route')).toMatchObject({
        outcome: 'ok',
        marketId: code,
      });
      expect(logLines.find((l) => l.msg === 'pricing.view-cost-route')).toMatchObject({
        outcome: 'ok',
      });
      expect(JSON.stringify(logLines)).not.toContain(CANARY);
    });
  });
});
