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
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// `GET /pricing/seller/offer-prices` over HTTP (Offer page PR 8): the real guards, controller,
// gate and `pricing.view-offers-prices`, with identity's ports and pricing's stores as in-memory
// fakes. Proved here: the seller session, no-store, the raw query reaching the use case, the
// shape of the answer and the status of each refusal.

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

describe('seller prices of several Offers over HTTP (offer page PR 8)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let series: InMemoryPriceSeries;
  let offers: FakeOfferSellUnits;
  const http = () => request(app.getHttpServer());

  async function boot() {
    ({ app } = await createTestApp({
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

  async function seeded(
    code: string,
    roleCode = 'seller-owner',
    sellerState: 'approved' | 'pending' = 'approved',
  ) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'price-0001'), {});
    const marketId = code as AccountState['marketId'];
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === roleCode,
    )!.id;
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state: sellerState,
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

  const get = (code: string, headers: Record<string, string>, query: string) =>
    http()
      .get(`/pricing/seller/offer-prices${query}`)
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
    it('answers the own Offers with no-store and leaves an unknown one out', async () => {
      await boot();
      await seeded(code);

      const answer = await get(code, sessionOf(code), `?offerIds=${id(0xc0ff)},${OFFER}`);

      expect(answer.status).toBe(200);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.body).toEqual({
        currency: code === 'AU' ? 'AUD' : 'JPY',
        offers: [
          {
            offerId: OFFER,
            variants: [
              {
                variantId: VARIANT,
                seriesVersion: null,
                currency: null,
                inForce: null,
                held: null,
                special: null,
                heldSpecial: null,
                retired: false,
              },
            ],
          },
        ],
      });
    });

    it('refuses a bad list with 400 and no session with 401', async () => {
      await boot();
      await seeded(code);

      const bad = await get(code, sessionOf(code), '?offerIds=not-a-uuid');
      const none = await get(code, sessionOf(code), '');
      const anonymous = await get(code, {}, `?offerIds=${OFFER}`);

      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'offerIds', code: 'format' }] },
      });
      expect(none.status).toBe(400);
      expect(anonymous.status).toBe(401);
    });

    it('leaves out an Offer of another seller, as it leaves out an unknown one', async () => {
      await boot();
      await seeded(code);
      const foreign = id<'Offer'>(0xc0aa);
      offers.put(marketOf(code), foreign, {
        sellerId: id<'Seller'>(0xb0aa),
        productId: PRODUCT,
        deleted: false,
        priceableVariantIds: [VARIANT],
      });

      const answer = await get(code, sessionOf(code), `?offerIds=${foreign},${OFFER}`);

      expect(answer.status).toBe(200);
      expect(
        (answer.body as { offers: { offerId: string }[] }).offers.map((o) => o.offerId),
      ).toEqual([OFFER]);
    });

    it('refuses a role without pricing.price.view, and a seller not yet approved, with 403', async () => {
      await boot();
      await seeded(code, 'customer-service');
      const noKey = await get(code, sessionOf(code), `?offerIds=${OFFER}`);
      await app.close();

      await boot();
      fakes.reset();
      await seeded(code, 'seller-owner', 'pending');
      const pending = await get(code, sessionOf(code), `?offerIds=${OFFER}`);

      expect(noKey.status).toBe(403);
      expect(noKey.headers['cache-control']).toBe('no-store');
      expect(noKey.body).toEqual({ statusCode: 403, code: 'access.denied' });
      expect(pending.status).toBe(403);
      expect(pending.body).toEqual({ statusCode: 403, code: 'access.seller-not-approved' });
    });
  });
});
