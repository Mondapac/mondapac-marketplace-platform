import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { OFFER_SELL_UNITS_SOURCE } from '../src/modules/pricing/application/ports/offer-sell-units';
import { FIRST_PRICE_REFERENCE } from '../src/modules/pricing/application/reference/variant-reference';
import { PRICE_SERIES_REPOSITORY } from '../src/modules/pricing/application/ports/price-series.repository';
import { WRITE_RATE_COUNTER_REPOSITORY } from '../src/modules/pricing/application/ports/write-rate-counter.repository';
import { WRITE_REFUSAL_THROTTLE_REPOSITORY } from '../src/modules/pricing/application/ports/write-refusal-throttle.repository';
import { AUDIT_WRITER } from '../src/platform/audit/audit-writer';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import {
  FakeOfferSellUnits,
  FakeUnitOfWork,
  InMemoryFirstPriceReference,
  InMemoryPriceSeries,
  InMemoryRefusalThrottles,
  InMemoryWriteRateCounters,
  RecordingAuditWriter,
  RecordingOutbox,
} from './support/pricing-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller regular-price route over HTTP (pricing slice 1, part 3c): the real guards,
// controller, gate and the real `pricing.set-regular-price` use case, with identity's ports and
// pricing's stores as in-memory fakes. Proved here: the seller session, the CSRF token, the
// key, the closed body, the status of each refusal and the log line.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

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

describe('seller typical prices over HTTP (offer page PR 9)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let clock: FixedClock;
  let series: InMemoryPriceSeries;
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
          .overrideProvider(PRICE_SERIES_REPOSITORY)
          .useValue(series)
          // R4's reads and checks in memory, on the same series (no database here).
          .overrideProvider(FIRST_PRICE_REFERENCE)
          .useValue(new InMemoryFirstPriceReference(series).ports)
          .overrideProvider(WRITE_REFUSAL_THROTTLE_REPOSITORY)
          .useValue(new InMemoryRefusalThrottles())
          .overrideProvider(WRITE_RATE_COUNTER_REPOSITORY)
          .useValue(new InMemoryWriteRateCounters())
          .overrideProvider(OFFER_SELL_UNITS_SOURCE)
          .useValue(offers)
          .overrideProvider(AUDIT_WRITER)
          .useValue(new RecordingAuditWriter())
          .overrideProvider(OUTBOX_WRITER)
          .useValue(new RecordingOutbox()),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'price-0001'), {});
    const marketId = code as AccountState['marketId'];
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
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

  const get = (code: string, headers: Record<string, string>, offerId: string = OFFER) =>
    http()
      .get(`/pricing/seller/offers/${offerId}/typical-prices`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    series = new InMemoryPriceSeries();
    offers = new FakeOfferSellUnits();
  });
  afterEach(async () => {
    await app.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('answers the Variants of the own Offer with no-store and no range without a reference', async () => {
      await boot();
      await seeded(code);

      const answer = await get(code, sessionOf(code));

      expect(answer.status).toBe(200);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.body).toEqual({
        offerId: OFFER,
        variants: [{ variantId: VARIANT, range: null }],
      });
      expect(logLines.find((l) => l.msg === 'pricing.view-typical-prices-route')).toMatchObject({
        outcome: 'ok',
        marketId: code,
      });
    });

    it('refuses without a session (401) and answers a bad id (400) and an unknown Offer (404)', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      expect((await get(code, {})).status).toBe(401);
      const bad = await get(code, session, 'nope');
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ code: 'validation.failed' });
      const unknown = await get(code, session, id<'Offer'>(0xc999));
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ statusCode: 404, code: 'pricing.offer-not-found' });
      expect(unknown.headers['cache-control']).toBe('no-store');
    });

    it('answers 429 with Retry-After after 20 reads in a minute', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      for (let i = 0; i < 20; i += 1) expect((await get(code, session)).status).toBe(200);
      const refused = await get(code, session);
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ code: 'request.throttled' });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(refused.headers['cache-control']).toBe('no-store');
    });
  });
});
