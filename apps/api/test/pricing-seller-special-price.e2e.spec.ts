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
import { PRICE_SERIES_REPOSITORY } from '../src/modules/pricing/application/ports/price-series.repository';
import { WRITE_REFUSAL_THROTTLE_REPOSITORY } from '../src/modules/pricing/application/ports/write-refusal-throttle.repository';
import { SPECIAL_PRICE_STATUS } from '../src/modules/pricing/presentation/seller-special-price.controller';
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
  InMemoryPriceSeries,
  InMemoryRefusalThrottles,
  RecordingAuditWriter,
  RecordingOutbox,
} from './support/pricing-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller special-price routes over HTTP (pricing slice 5): the real guards, controller,
// gate and the real `pricing.set-special-price` and `pricing.withdraw-special-price` use cases, with identity's ports and
// pricing's stores as in-memory fakes. Proved here: the seller session, the CSRF token, the
// key, the closed body, the status of each refusal and the log line.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const CURRENCY: Record<string, string> = { AU: 'AUD', ZZ: 'JPY' };

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

it('maps every refusal code of the use cases to its exact status', () => {
  expect(SPECIAL_PRICE_STATUS).toEqual({
    'validation.failed': 400,
    'pricing.offer-not-found': 404,
    'pricing.special-price.not-found': 404,
    'pricing.currency-mismatch': 422,
    'pricing.amount-out-of-range': 422,
    'pricing.special-not-below-regular': 422,
    'pricing.special-window.invalid': 422,
    'pricing.special-window.start-in-past': 422,
    'pricing.no-regular-price': 409,
    'pricing.series-retired': 409,
    'conflict.stale': 409,
  });
});

describe('seller special price over HTTP (integration, pricing slice 5)', () => {
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
          .overrideProvider(WRITE_REFUSAL_THROTTLE_REPOSITORY)
          .useValue(new InMemoryRefusalThrottles())
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

  const headersOf = (code: string, extra: Record<string, string>) => ({
    'x-market-id': code,
    ...panelHeaders(code, 'seller'),
    ...extra,
  });
  const base = (offerId: string = OFFER) => `/pricing/seller/offers/${offerId}/variants/${VARIANT}`;
  const regular = (code: string, headers: Record<string, string>) =>
    http()
      .put(`${base()}/regular-price`)
      .set(headersOf(code, headers))
      .send({ amount: '10000', currency: CURRENCY[code], expectedVersion: null });
  const special = (
    code: string,
    payload: unknown,
    headers: Record<string, string>,
    offerId: string = OFFER,
  ) =>
    http()
      .put(`${base(offerId)}/special-price`)
      .set(headersOf(code, headers))
      .send(payload as object);
  const withdraw = (code: string, payload: unknown, headers: Record<string, string>) =>
    http()
      .post(`${base()}/special-price/withdraw`)
      .set(headersOf(code, headers))
      .send(payload as object);
  const body = (code: string, extra: Record<string, unknown> = {}) => ({
    amount: '9000',
    currency: CURRENCY[code],
    startsAt: null,
    endsAt: '2026-10-12T10:00:00Z',
    expectedVersion: 2,
    ...extra,
  });

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
    it('sets a special, replaces it, then withdraws it, logging the outcome', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      expect((await regular(code, session)).status).toBe(200);

      const written = await special(code, body(code), session);

      expect(written.status).toBe(200);
      expect(written.body).toMatchObject({ status: 'accepted', seriesVersion: 3 });
      expect(
        logLines.find((l) => l.msg === 'pricing.set-special-price' && l.outcome),
      ).toMatchObject({ outcome: 'accepted', marketId: code });

      const ended = await withdraw(code, { expectedVersion: 3 }, session);
      expect(ended.status).toBe(200);
      expect(ended.body).toMatchObject({ seriesVersion: 4 });
      const again = await withdraw(code, { expectedVersion: 4 }, session);
      expect(again.status).toBe(404);
      expect(again.body).toEqual({ statusCode: 404, code: 'pricing.special-price.not-found' });
    });

    it('refuses without the CSRF token and without a session, storing nothing new', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      await regular(code, session);

      const noCsrf = await special(code, body(code), { cookie: session.cookie });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect((await special(code, body(code), {})).status).toBe(401);
      expect((await withdraw(code, { expectedVersion: 2 }, {})).status).toBe(401);
    });

    it('refuses an unknown field, a missing field and a bad amount or window', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      await regular(code, session);

      const extra = await special(code, body(code, { sellerId: 'x' }), session);
      expect(extra.status).toBe(400);
      expect(extra.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'sellerId', code: 'unknown-field' }] },
      });
      const missing = await special(code, { amount: '9000', currency: CURRENCY[code] }, session);
      expect(missing.status).toBe(400);
      const format = await special(code, body(code, { amount: '90.00' }), session);
      expect(format.status).toBe(400);
      const wrongCurrency = await special(code, body(code, { currency: 'XXX' }), session);
      expect(wrongCurrency.status).toBe(422);
      const backwards = await special(
        code,
        body(code, { endsAt: '2026-10-09T09:00:00Z' }),
        session,
      );
      expect(backwards.status).toBe(422);
    });

    it('refuses a special at or above the regular price as 422, and none without one as 409', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const none = await special(code, body(code, { expectedVersion: 1 }), session);
      expect(none.status).toBe(409);
      expect(none.body).toEqual({ statusCode: 409, code: 'pricing.no-regular-price' });

      await regular(code, session);
      const equal = await special(code, body(code, { amount: '10000' }), session);
      expect(equal.status).toBe(422);
      expect(equal.body).toEqual({
        statusCode: 422,
        code: 'pricing.special-not-below-regular',
      });
    });

    it('answers an unknown or foreign Offer as one 404 and a stale version as 409', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      await regular(code, session);

      const unknown = await special(code, body(code), session, id<'Offer'>(0xc999));
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ statusCode: 404, code: 'pricing.offer-not-found' });
      const stale = await special(code, body(code, { expectedVersion: 1 }), session);
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({ statusCode: 409, code: 'conflict.stale' });

      offers.put(marketOf(code), OFFER, {
        sellerId: id<'Seller'>(0xb999),
        productId: PRODUCT,
        deleted: false,
        priceableVariantIds: [VARIANT],
      });
      const foreign = await special(code, body(code), session);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(unknown.body);
    });
  });
});
