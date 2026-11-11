import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CheckClaimText } from '../src/modules/catalog/application/claim-text/check-claim-text.service';
import { CLAIM_EVALUATOR } from '../src/modules/catalog/application/ports/claim-evaluator';
import { ClaimQueryBuilder } from '../src/modules/catalog/application/tags/claim-query-builder';
import { ALLOWED_PRODUCT_TYPES_READER } from '../src/modules/catalog/application/ports/allowed-product-types.reader';
import {
  CATALOG_MARKET_POLICY,
  type CatalogMarketPolicy,
} from '../src/modules/catalog/application/ports/catalog-market-policy';
import { OFFER_REPOSITORY } from '../src/modules/catalog/application/ports/offer.repository';
import { OFFER_SELL_UNIT_REPOSITORY } from '../src/modules/catalog/application/ports/offer-sell-unit.repository';
import { OFFER_SELL_UNITS_READER } from '../src/modules/catalog/application/ports/offer-sell-units.reader';
import { PRODUCT_SELL_UNIT_FACTS_READER } from '../src/modules/catalog/application/ports/product-sell-unit-facts.reader';
import { SELL_UNIT_LABELS_READER } from '../src/modules/catalog/application/ports/sell-unit-labels.reader';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { SaveWorkingCopy } from '../src/modules/catalog/application/working-copy/save-working-copy.service';
import { Offer, type OfferState } from '../src/modules/catalog/domain/offer';
import { Product, type ProductState } from '../src/modules/catalog/domain/product';
import { OWN_OFFER_STATUS } from '../src/modules/catalog/presentation/own-offer.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import {
  FakeClaimEvaluator,
  FixedFactsClaimQueryBuilder,
  activeTagState,
  allowedDecision,
  refusedDecision,
} from './support/catalog-tag-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller Offer create route over HTTP (catalog design 4.4, 8.2; slice 7a-3): the real guards,
// controller, gate and the real `own-offer.create-on-platform-product` use case, with identity's
// ports and catalog's stores as in-memory fakes. Proved here: the seller session, the CSRF token,
// the key, the closed body, the status of each refusal, the throttle headers and the log line.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const SELLER = id<'Seller'>(0xb020);
const PRODUCT = id<'Product'>(0xc001);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('seller Offer create over HTTP (integration, slice 7a-3)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let stored: Offer[];
  let product: Product | null;
  let eligible: boolean;
  let reserve: unknown;
  let addRefusal: string | null;
  let offer: Offer | null;
  let saveRefusal: string | null;
  let savedEdits: Offer[];
  let sellUnitRows: {
    variantId: string;
    variantNo: number;
    variantSku: string | null;
    selling: boolean;
  }[];
  let sellUnitSaves: unknown[][];
  let sellUnitRefusal: string | null;
  let offerReads: number;
  let allowed: unknown;
  let verdicts: unknown[];
  let productReads: number;
  let claimChecks: number;
  let evaluator: FakeClaimEvaluator;
  let claimFacts: FixedFactsClaimQueryBuilder;
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
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({
            findById: () => {
              productReads += 1;
              return Promise.resolve(product);
            },
          })
          .overrideProvider(OFFER_REPOSITORY)
          .useValue({
            add: (_m: unknown, offer: Offer) => {
              if (addRefusal !== null) return Promise.resolve(addRefusal);
              stored.push(offer);
              return Promise.resolve(null);
            },
            findById: () => {
              offerReads += 1;
              return Promise.resolve(offer);
            },
            save: (_m: unknown, edited: Offer) => {
              if (saveRefusal !== null) return Promise.resolve(saveRefusal);
              savedEdits.push(edited);
              return Promise.resolve(null);
            },
          })
          .overrideProvider(OFFER_SELL_UNIT_REPOSITORY)
          .useValue({
            lockOffer: () => Promise.resolve(),
            unitsOf: () => Promise.resolve(sellUnitRows),
            save: (_m: unknown, _o: unknown, states: unknown[]) => {
              if (sellUnitRefusal !== null) return Promise.resolve({ refusal: sellUnitRefusal });
              sellUnitSaves.push(states);
              return Promise.resolve({ refusal: null, stored: [] });
            },
          })
          .overrideProvider(OFFER_SELL_UNITS_READER)
          .useValue({
            read: (_m: unknown, ids: Id<'Offer'>[]) =>
              Promise.resolve(
                new Map(
                  ids.map((offerId) => [
                    offerId,
                    {
                      sellerId: SELLER,
                      productId: PRODUCT,
                      status: 'draft',
                      listed: false,
                      sellUnits: sellUnitRows.map((row) => ({
                        variantId: row.variantId,
                        state: 'published',
                        selling: row.selling,
                        variantSku: row.variantSku,
                      })),
                    },
                  ]),
                ),
              ),
          })
          .overrideProvider(PRODUCT_SELL_UNIT_FACTS_READER)
          .useValue({
            read: () =>
              Promise.resolve({
                scope: 'PLATFORM',
                productCode: 'MP-000123',
                variants: sellUnitRows.map((row) => ({
                  variantId: row.variantId,
                  variantNo: row.variantNo,
                })),
              }),
          })
          .overrideProvider(SELL_UNIT_LABELS_READER)
          .useValue({
            read: (_m: unknown, keys: { offerId: string; variantId: string }[]) =>
              Promise.resolve(
                new Map(
                  keys
                    .filter((key) => key.variantId.endsWith('a101'))
                    .map((key) => [
                      `${key.offerId}:${key.variantId}`,
                      { productName: 'Rice', variantLabel: 'Small' },
                    ]),
                ),
              ),
          })
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(eligible) })
          .overrideProvider(ALLOWED_PRODUCT_TYPES_READER)
          .useValue({ allowedFor: () => Promise.resolve(allowed) })
          .overrideProvider(CheckClaimText)
          .useValue({
            execute: () => {
              claimChecks += 1;
              return Promise.resolve({ ok: true, value: verdicts });
            },
          })
          .overrideProvider(SaveWorkingCopy)
          .useValue({ reserveSaves: () => Promise.resolve(reserve) })
          .overrideProvider(CLAIM_EVALUATOR)
          .useValue(evaluator)
          .overrideProvider(ClaimQueryBuilder)
          .useValue(claimFacts),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const state = (code: string): ProductState => ({
    id: PRODUCT,
    marketId: code as AccountState['marketId'],
    scope: 'PLATFORM',
    ownerSellerId: null,
    createdBySellerId: null,
    typeCode: 'simple',
    variantModel: 'single',
    familyCode: 'default',
    productCode: 'P00000001',
    status: 'published',
    discardedAt: null,
    withdrawnAt: null,
    retiredAt: null,
    pausedAt: null,
    pausedByAccountId: null,
    ownBrand: false,
    lastChangedAt: START,
    version: 3,
    createdAt: START,
    publishedRevisionId: id<'ProductRevision'>(0xd001),
    pendingRevisionId: null,
    pendingSubmittedAt: null,
    variants: [],
  });

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'offer-0001'), {});
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
    product = Product.restore(state(code));
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

  const body = (extra: Record<string, unknown> = {}) => ({
    productId: PRODUCT,
    sellerSku: 'SKU-1',
    conditionCode: 'new',
    description: {},
    ...extra,
  });
  const send = (code: string, payload: unknown, headers: Record<string, string>) =>
    http()
      .post('/catalog/seller/offers')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers })
      .send(payload as object);

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    stored = [];
    product = null;
    eligible = true;
    reserve = null;
    addRefusal = null;
    offer = null;
    saveRefusal = null;
    savedEdits = [];
    sellUnitRows = [];
    sellUnitSaves = [];
    sellUnitRefusal = null;
    offerReads = 0;
    allowed = 'all';
    verdicts = [];
    productReads = 0;
    claimChecks = 0;
    evaluator = new FakeClaimEvaluator(() => {
      throw new Error('no claim was expected');
    }, []);
    claimFacts = new FixedFactsClaimQueryBuilder(null);
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the route and its error codes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const responses = document.paths['/catalog/seller/offers']?.post?.responses;
    for (const status of ['201', '400', '403', '404', '409', '422', '429', '503']) {
      expect(responses).toHaveProperty(status);
    }
    const submit = document.paths['/catalog/seller/offers/{offerId}/submit']?.post?.responses;
    for (const status of ['200', '400', '403', '404', '409', '422', '503']) {
      expect(submit).toHaveProperty(status);
    }
    const remove = document.paths['/catalog/seller/offers/{offerId}']?.delete?.responses;
    for (const status of ['204', '400', '403', '404', '409', '422', '503']) {
      expect(remove).toHaveProperty(status);
    }
    const handling = document.paths['/catalog/seller/offers/{offerId}/handling']?.put?.responses;
    for (const status of ['200', '400', '403', '404', '409', '429', '503']) {
      expect(handling).toHaveProperty(status);
    }
    const edit = document.paths['/catalog/seller/offers/{offerId}']?.put?.responses;
    for (const status of ['200', '400', '403', '404', '409', '422', '429', '503']) {
      expect(edit).toHaveProperty(status);
    }
    // Booting the app with the docs route builds the whole OpenAPI document; under a loaded
    // runner that alone can pass the default 5 s.
  }, 30_000);

  it('maps every refusal code of the use case to its exact status', () => {
    expect(OWN_OFFER_STATUS).toEqual({
      'validation.failed': 400,
      'product.not-found': 404,
      'offer.not-found': 404,
      'offer.not-editable': 409,
      'offer.not-submittable': 409,
      'offer.product-not-published': 409,
      'offer.handling-missing': 422,
      'offer.attestation-needs-sealed-original': 422,
      'offer.delete-via-product': 422,
      'conflict.stale': 409,
      'seller.not-eligible': 403,
      'offer.exists-for-product': 409,
      'offer.sku-taken': 409,
      'offer.none-selling': 422,
      'type.not-allowed': 422,
      'setting.sell-from-catalogue-off': 422,
      'claim-text.refused': 422,
      'request.throttled': 429,
      'access.unavailable': 503,
      'tag.exists': 409,
      'tag.not-found': 404,
      'tag.suspended': 409,
      'tag.not-removable': 409,
      'tag.not-suspended': 409,
      'tag.product-not-published': 409,
      'tag.type-unknown': 422,
      'claim.tag-not-allowed': 422,
      'claim.requested-tag-not-allowed': 422,
      'claim.check-unavailable': 503,
      'conflict.retry': 409,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('creates a draft Offer for the session’s seller and logs the outcome', async () => {
      await boot();
      await seeded(code);

      const created = await send(code, body(), sessionOf(code));

      expect(created.status).toBe(201);
      expect(stored).toHaveLength(1);
      expect(created.body).toEqual({ offerId: stored[0]!.state.id });
      expect(stored[0]!.state).toMatchObject({
        sellerId: SELLER,
        productId: PRODUCT,
        status: 'draft',
        marketId: code,
      });
      expect(logLines.find((l) => l.msg === 'catalog.own-offer-create' && l.outcome)).toMatchObject(
        {
          outcome: 'ok',
          marketId: code,
          correlationId: created.headers['x-correlation-id'] as string,
        },
      );
    });

    it('refuses without the CSRF token and without a session, storing nothing', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const noCsrf = await send(code, body(), { cookie: session.cookie });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect((await send(code, body(), {})).status).toBe(401);
      expect(stored).toHaveLength(0);
    });

    it('refuses an unknown field, a missing field, an array and a non-JSON body', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const extra = await send(code, body({ sellerId: 'x' }), session);
      expect(extra.status).toBe(400);
      expect(extra.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'sellerId', code: 'unknown-field' }] },
      });
      const withoutDescription = { productId: PRODUCT, sellerSku: 'SKU-1', conditionCode: 'new' };
      const missing = await send(code, withoutDescription, session);
      expect(missing.body).toMatchObject({
        details: { fields: [{ path: 'description', code: 'required' }] },
      });
      expect((await send(code, [], session)).status).toBe(400);
      const text = await http()
        .post('/catalog/seller/offers')
        .set({
          'x-market-id': code,
          ...panelHeaders(code, 'seller'),
          ...session,
          'content-type': 'text/plain',
        })
        .send('x');
      expect(text.status).toBe(415);
      expect(stored).toHaveLength(0);
    });

    it('answers a spent budget as 429 with Retry-After, before any work', async () => {
      await boot();
      await seeded(code);
      reserve = { code: 'request.throttled', retryAfterSeconds: 12 };

      const throttled = await send(code, body(), sessionOf(code));

      expect(throttled.status).toBe(429);
      expect(throttled.headers['retry-after']).toBe('12');
      expect(throttled.body).toEqual({
        statusCode: 429,
        code: 'request.throttled',
        details: { retryAfterSeconds: 12 },
      });
      expect(stored).toHaveLength(0);
    });

    it('answers a seller who may not sell as 403 and an unknown product as 404', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      eligible = false;
      const notEligible = await send(code, body(), session);
      expect(notEligible.status).toBe(403);
      expect(notEligible.body).toEqual({ statusCode: 403, code: 'seller.not-eligible' });

      eligible = true;
      product = null;
      const unknown = await send(code, body(), session);
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ statusCode: 404, code: 'product.not-found' });
      expect(stored).toHaveLength(0);
    });

    it('answers 409, 422 and 503 with the refusal code', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      for (const refusal of ['offer.exists-for-product', 'offer.sku-taken']) {
        addRefusal = refusal;
        const taken = await send(code, body(), session);
        expect(taken.status).toBe(409);
        expect(taken.body).toEqual({ statusCode: 409, code: refusal });
      }
      addRefusal = null;

      allowed = new Set(['configurable']);
      const notAllowed = await send(code, body(), session);
      expect(notAllowed.status).toBe(422);
      expect(notAllowed.body).toEqual({ statusCode: 422, code: 'type.not-allowed' });

      allowed = null;
      const unavailable = await send(code, body(), session);
      expect(unavailable.status).toBe(503);
      expect(unavailable.body).toEqual({ statusCode: 503, code: 'access.unavailable' });
      expect(stored).toHaveLength(0);
    });

    it('answers a text with a claim as 422 with the refused fields, storing nothing', async () => {
      await boot();
      await seeded(code);
      const locale = app
        .get<CatalogMarketPolicy>(CATALOG_MARKET_POLICY)
        .locales(marketOf(code)).default;
      verdicts = [
        { code: 'claim-text.found', field: 'offer.description', ref: null, locale, hits: [] },
      ];

      const refused = await send(
        code,
        body({ description: { [locale]: 'Certified halal' } }),
        sessionOf(code),
      );

      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        statusCode: 422,
        code: 'claim-text.refused',
        details: { fields: [{ field: 'offer.description', locale }] },
      });
      expect(stored).toHaveLength(0);
    });

    it('refuses the admin panel origin and a missing Sec-Fetch-Site, storing nothing', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const wrongOrigin = await http()
        .post('/catalog/seller/offers')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
        .send(body());
      expect(wrongOrigin.status).toBe(403);
      expect(wrongOrigin.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      const noFetchSite = await http()
        .post('/catalog/seller/offers')
        .set({ 'x-market-id': code, origin: panelHeaders(code, 'seller').origin, ...session })
        .send(body());
      expect(noFetchSite.status).toBe(403);
      expect(noFetchSite.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect(stored).toHaveLength(0);
    });

    it('answers every product that is not offerable with the same 404 body', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      const bodies: string[] = [];
      for (const overrides of [
        null,
        { status: 'draft' as const, publishedRevisionId: null },
        { scope: 'SELLER' as const, ownerSellerId: SELLER, createdBySellerId: SELLER },
      ]) {
        product = overrides === null ? null : Product.restore({ ...state(code), ...overrides });
        const answer = await send(code, body(), session);
        expect(answer.status).toBe(404);
        bodies.push(JSON.stringify(answer.body));
      }
      expect(new Set(bodies).size).toBe(1);
    });

    it('does no work before a spent budget answers, and logs no text', async () => {
      await boot();
      await seeded(code);
      reserve = { code: 'request.throttled', retryAfterSeconds: 3 };
      const locale = app
        .get<CatalogMarketPolicy>(CATALOG_MARKET_POLICY)
        .locales(marketOf(code)).default;

      await send(
        code,
        body({ sellerSku: 'SECRET-SKU', description: { [locale]: 'secret text' } }),
        sessionOf(code),
      );

      expect(productReads).toBe(0);
      expect(claimChecks).toBe(0);
      const line = logLines.find((l) => l.msg === 'catalog.own-offer-create' && l.outcome);
      expect(JSON.stringify(line)).not.toMatch(/SECRET-SKU|secret text/);
    });
  });

  describe.each(TEST_MARKETS)('submit and delete in market %s', (code) => {
    const OFFER = id<'Offer'>(0x9001);
    const offerState = (overrides: Partial<OfferState> = {}): OfferState => ({
      id: OFFER,
      marketId: code as AccountState['marketId'],
      sellerId: SELLER,
      productId: PRODUCT,
      sellerSku: 'SKU-1',
      conditionCode: 'new',
      description: { 'en-AU': 'Fresh dates' },
      handling: 'SEALED_ORIGINAL',
      attestationRecordedAt: null,
      attestationAccountId: null,
      status: 'draft',
      offSaleCauses: [],
      listed: false,
      submittedAt: null,
      firstPublishedAt: null,
      deletedAt: null,
      version: 2,
      createdAt: START,
      ...overrides,
    });
    const route = (method: 'post' | 'delete', suffix: string, headers: Record<string, string>) =>
      http()
        [method](`/catalog/seller/offers/${OFFER}${suffix}`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers });

    it('submits an own draft Offer: pending or published by the Market, seller actor, logged', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());

      const response = await route('post', '/submit', sessionOf(code)).send();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ published: expect.any(Boolean) as unknown });
      expect(savedEdits).toHaveLength(1);
      const { status, version, submittedAt } = savedEdits[0]!.state;
      expect(status).toBe(
        (response.body as { published: boolean }).published ? 'published' : 'pending-first-publish',
      );
      expect([version, submittedAt]).toEqual([3, START]);
      expect(claimChecks).toBe(1);
      expect(logLines.find((l) => l.msg === 'catalog.own-offer-submit' && l.outcome)).toMatchObject(
        { outcome: 'ok', marketId: code },
      );
    });

    it('answers 422 without handling and 409 for an Offer that is not a draft, storing nothing', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState({ handling: null }));
      const noHandling = await route('post', '/submit', sessionOf(code)).send();
      expect(noHandling.status).toBe(422);
      expect(noHandling.body).toEqual({ statusCode: 422, code: 'offer.handling-missing' });

      offer = Offer.restore(
        offerState({ status: 'pending-first-publish', submittedAt: START, version: 3 }),
      );
      const waiting = await route('post', '/submit', sessionOf(code)).send();
      expect(waiting.status).toBe(409);
      expect(waiting.body).toEqual({ statusCode: 409, code: 'offer.not-submittable' });
      expect(savedEdits).toHaveLength(0);
    });

    it('answers a repeated submit as offer.not-submittable before any product or claim check', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(
        offerState({ status: 'pending-first-publish', submittedAt: START, version: 3 }),
      );
      product = Product.restore({ ...state(code), status: 'unpublished' });

      const response = await route('post', '/submit', sessionOf(code)).send();

      expect(response.body).toEqual({ statusCode: 409, code: 'offer.not-submittable' });
      expect(claimChecks).toBe(0);
    });

    it('answers 409 for an unpublished product, 422 for a type or a claim, 403 for an ineligible seller', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());
      const session = () => sessionOf(code);

      product = Product.restore({ ...state(code), status: 'unpublished' });
      expect((await route('post', '/submit', session()).send()).body).toMatchObject({
        code: 'offer.product-not-published',
      });
      product = Product.restore(state(code));
      allowed = new Set<string>();
      expect((await route('post', '/submit', session()).send()).body).toMatchObject({
        code: 'type.not-allowed',
      });
      allowed = 'all';
      verdicts = [
        {
          code: 'claim-text.found',
          field: 'offer.description',
          ref: null,
          locale: 'en-AU',
          hits: [],
        },
      ];
      expect((await route('post', '/submit', session()).send()).status).toBe(422);
      verdicts = [];
      eligible = false;
      expect((await route('post', '/submit', session()).send()).status).toBe(403);
      expect(savedEdits).toHaveLength(0);
    });

    it('answers every Offer that is not the seller’s to submit or delete with the same 404 body', async () => {
      await boot();
      await seeded(code);
      const bodies: unknown[] = [];
      for (const found of [
        null,
        Offer.restore(offerState({ sellerId: id<'Seller'>(0xb999) })),
        Offer.restore(offerState({ status: 'deleted', deletedAt: START })),
      ]) {
        offer = found;
        const submit = await route('post', '/submit', sessionOf(code)).send();
        const remove = await route('delete', '', sessionOf(code)).send();
        expect([submit.status, remove.status]).toEqual([404, 404]);
        bodies.push(submit.body, remove.body);
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(savedEdits).toHaveLength(0);
    });

    it('deletes an own Offer on a PLATFORM product: 204, deleted, not listed, event, logged', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(
        offerState({
          status: 'published',
          listed: true,
          firstPublishedAt: START,
          submittedAt: START,
        }),
      );

      const response = await route('delete', '', sessionOf(code)).send();

      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect(savedEdits).toHaveLength(1);
      expect(savedEdits[0]!.state).toMatchObject({
        status: 'deleted',
        listed: false,
        deletedAt: START,
        version: 3,
      });
      expect(savedEdits[0]!.pendingHistory).toMatchObject({ changeKind: 'deleted' });
      expect(savedEdits[0]!.pendingEvents.map((e) => e.type)).toEqual(['catalog.offer-deleted.v1']);
      expect(logLines.find((l) => l.msg === 'catalog.own-offer-delete' && l.outcome)).toMatchObject(
        { outcome: 'ok', marketId: code },
      );
    });

    it('refuses to delete an Offer on the seller’s own product, and reads no other eligibility', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());
      product = Product.restore({
        ...state(code),
        scope: 'SELLER',
        ownerSellerId: SELLER,
        createdBySellerId: SELLER,
      });
      const own = await route('delete', '', sessionOf(code)).send();
      expect(own.status).toBe(422);
      expect(own.body).toEqual({ statusCode: 422, code: 'offer.delete-via-product' });
      expect(savedEdits).toHaveLength(0);

      product = Product.restore(state(code));
      eligible = false;
      expect((await route('delete', '', sessionOf(code)).send()).status).toBe(204);
    });

    it('refuses both routes without the CSRF token and without a session, and a bad id', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());
      const session = sessionOf(code);

      for (const method of ['post', 'delete'] as const) {
        const suffix = method === 'post' ? '/submit' : '';
        const noCsrf = await route(method, suffix, { cookie: session.cookie }).send();
        expect(noCsrf.status).toBe(403);
        expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
        expect((await route(method, suffix, {}).send()).status).toBe(401);
      }
      const bad = await http()
        .delete('/catalog/seller/offers/not-an-id')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...session });
      expect(bad.status).toBe(400);
      expect(savedEdits).toHaveLength(0);
    });
  });

  describe.each(TEST_MARKETS)('edit in market %s', (code) => {
    const OFFER = id<'Offer'>(0x9001);
    const offerState = (overrides: Partial<OfferState> = {}): OfferState => ({
      id: OFFER,
      marketId: code as AccountState['marketId'],
      sellerId: SELLER,
      productId: PRODUCT,
      sellerSku: 'SKU-1',
      conditionCode: 'new',
      description: {},
      handling: null,
      attestationRecordedAt: null,
      attestationAccountId: null,
      status: 'draft',
      offSaleCauses: [],
      listed: false,
      submittedAt: null,
      firstPublishedAt: null,
      deletedAt: null,
      version: 2,
      createdAt: START,
      ...overrides,
    });
    const editBody = (extra: Record<string, unknown> = {}) => ({
      sellerSku: 'SKU-2',
      conditionCode: 'new',
      description: {},
      ...extra,
    });
    const put = (path: string, payload: unknown, headers: Record<string, string>) =>
      http()
        .put(path)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers })
        .send(payload as object);
    const url = `/catalog/seller/offers/${OFFER}`;

    it('edits an own draft Offer, answers the changed fields and logs the outcome', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());

      const edited = await put(url, editBody(), sessionOf(code));

      expect(edited.status).toBe(200);
      expect(edited.body).toEqual({ changedFields: ['sellerSku'] });
      expect(savedEdits).toHaveLength(1);
      expect(savedEdits[0]!.state).toMatchObject({ sellerSku: 'SKU-2', version: 3 });
      expect(logLines.find((l) => l.msg === 'catalog.own-offer-edit' && l.outcome)).toMatchObject({
        outcome: 'ok',
        marketId: code,
        correlationId: edited.headers['x-correlation-id'] as string,
      });
    });

    it('refuses without the CSRF token and without a session, and PATCH and POST are not routes', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());
      const session = sessionOf(code);

      expect((await put(url, editBody(), { cookie: session.cookie })).body).toEqual({
        statusCode: 403,
        code: 'request.csrf',
      });
      expect((await put(url, editBody(), {})).status).toBe(401);
      const patch = await http()
        .patch(url)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...session })
        .send(editBody());
      expect(patch.status).toBe(404);
      expect(savedEdits).toHaveLength(0);
    });

    it('refuses an unknown field, a missing field, an array and a bad id', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());
      const session = sessionOf(code);

      const extra = await put(url, editBody({ handling: 'FRESH' }), session);
      expect(extra.status).toBe(400);
      expect(extra.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'handling', code: 'unknown-field' }] },
      });
      const missing = await put(url, { sellerSku: 'SKU-2', conditionCode: 'new' }, session);
      expect(missing.body).toMatchObject({
        details: { fields: [{ path: 'description', code: 'required' }] },
      });
      expect((await put(url, [], session)).status).toBe(400);
      const badId = await put('/catalog/seller/offers/not-an-id', editBody(), session);
      expect(badId.status).toBe(400);
      expect(badId.body).toMatchObject({ details: { fields: [{ path: 'offerId' }] } });
      expect(savedEdits).toHaveLength(0);
    });

    it('answers every Offer that is not the seller’s to edit with the same 404 body', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      const bodies: string[] = [];
      for (const found of [
        null,
        offerState({ sellerId: id<'Seller'>(0xb999) }),
        offerState({ status: 'deleted', deletedAt: START }),
      ]) {
        offer = found === null ? null : Offer.restore(found);
        const answer = await put(url, editBody(), session);
        expect(answer.status).toBe(404);
        bodies.push(JSON.stringify(answer.body));
      }
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toBe(JSON.stringify({ statusCode: 404, code: 'offer.not-found' }));
      expect(savedEdits).toHaveLength(0);
    });

    it('edits a published Offer in place, answers 409 for a taken SKU and 403 for a seller who may not sell', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      offer = Offer.restore(
        offerState({ status: 'published', firstPublishedAt: START, handling: 'FRESH' }),
      );
      const published = await put(url, editBody(), session);
      expect(published.status).toBe(200);
      expect(savedEdits.at(-1)?.state.status).toBe('published');

      offer = Offer.restore(offerState());
      saveRefusal = 'offer.sku-taken';
      const taken = await put(url, editBody(), session);
      expect(taken.status).toBe(409);
      expect(taken.body).toEqual({ statusCode: 409, code: 'offer.sku-taken' });
      saveRefusal = null;

      eligible = false;
      const notEligible = await put(url, editBody(), session);
      expect(notEligible.status).toBe(403);
      expect(notEligible.body).toEqual({ statusCode: 403, code: 'seller.not-eligible' });
      expect(savedEdits).toHaveLength(1);
    });

    it('answers a text with a claim as 422 and a spent budget as 429, storing nothing', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());
      const session = sessionOf(code);
      const locale = app
        .get<CatalogMarketPolicy>(CATALOG_MARKET_POLICY)
        .locales(marketOf(code)).default;
      verdicts = [
        { code: 'claim-text.found', field: 'offer.description', ref: null, locale, hits: [] },
      ];

      const refused = await put(
        url,
        editBody({ description: { [locale]: 'Certified halal' } }),
        session,
      );
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'claim-text.refused',
        details: { fields: [{ field: 'offer.description', locale }] },
      });

      reserve = { code: 'request.throttled', retryAfterSeconds: 9 };
      const checksBefore = claimChecks;
      const readsBefore = offerReads;
      const throttled = await put(url, editBody(), session);
      expect(throttled.status).toBe(429);
      expect(throttled.headers['retry-after']).toBe('9');
      expect(claimChecks).toBe(checksBefore);
      expect(offerReads).toBe(readsBefore);
      expect(savedEdits).toHaveLength(0);
    });

    it('refuses the admin panel origin, storing nothing, and logs no text', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());
      const session = sessionOf(code);

      const wrongOrigin = await http()
        .put(url)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
        .send(editBody());
      expect(wrongOrigin.status).toBe(403);
      expect(savedEdits).toHaveLength(0);

      const locale = app
        .get<CatalogMarketPolicy>(CATALOG_MARKET_POLICY)
        .locales(marketOf(code)).default;
      await put(
        url,
        editBody({ sellerSku: 'SECRET-SKU', description: { [locale]: 'secret text' } }),
        session,
      );
      expect(
        JSON.stringify(logLines.filter((l) => l.msg === 'catalog.own-offer-edit')),
      ).not.toMatch(/SECRET-SKU|secret text/);
    });

    it('records the handling of an own draft Offer, answers the changed field and logs it', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());
      const session = sessionOf(code);

      const set = await put(`${url}/handling`, { handling: 'SEALED_ORIGINAL' }, session);

      expect(set.status).toBe(200);
      expect(set.body).toEqual({ changedFields: ['handling'] });
      expect(savedEdits[0]!.state).toMatchObject({ handling: 'SEALED_ORIGINAL', version: 3 });
      expect(
        logLines.find((l) => l.msg === 'catalog.own-offer-set-handling' && l.outcome),
      ).toMatchObject({ outcome: 'ok', marketId: code });
    });

    it('refuses handling without CSRF or a session, a bad body and a stranger’s Offer; changes a published one', async () => {
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());
      const session = sessionOf(code);
      const path = `${url}/handling`;

      expect((await put(path, { handling: 'FRESH' }, { cookie: session.cookie })).status).toBe(403);
      expect((await put(path, { handling: 'FRESH' }, {})).status).toBe(401);
      for (const body of [{}, { handling: 'nope' }, { handling: 'FRESH', attestation: true }]) {
        expect((await put(path, body, session)).status).toBe(400);
      }
      offer = Offer.restore(
        offerState({ status: 'published', listed: true, firstPublishedAt: START }),
      );
      expect((await put(path, { handling: 'FRESH' }, session)).body).toEqual({
        changedFields: ['handling'],
      });
      offer = Offer.restore(offerState({ sellerId: id<'Seller'>(0xb999) }));
      expect((await put(path, { handling: 'FRESH' }, session)).body).toEqual({
        statusCode: 404,
        code: 'offer.not-found',
      });
      const wrongOrigin = await http()
        .put(path)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
        .send({ handling: 'FRESH' });
      expect(wrongOrigin.status).toBe(403);
      expect(savedEdits).toHaveLength(1);
    });
  });

  describe.each(TEST_MARKETS)('tags in market %s', (code) => {
    const OFFER = id<'Offer'>(0x9101);
    const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
    const certificate = {
      certificateId: id(0x7001),
      versionId: id(0x7002),
      typeRevisionId: id(0x7003),
    };
    const offerState = (overrides: Partial<OfferState> = {}): OfferState => ({
      id: OFFER,
      marketId: code as AccountState['marketId'],
      sellerId: SELLER,
      productId: PRODUCT,
      sellerSku: 'SKU-1',
      conditionCode: 'new',
      description: {},
      handling: 'SEALED_ORIGINAL',
      attestationRecordedAt: null,
      attestationAccountId: null,
      status: 'published',
      offSaleCauses: [],
      listed: true,
      submittedAt: START,
      firstPublishedAt: START,
      deletedAt: null,
      version: 2,
      createdAt: START,
      ...overrides,
    });
    const tagsUrl = `/catalog/seller/offers/${OFFER}/tags`;
    const withMarket = (test: request.Test, headers: Record<string, string>) =>
      test.set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers });
    const arm = (
      decide = (q: Parameters<typeof allowedDecision>[0]) => allowedDecision(q, certificate),
    ) => {
      evaluator.decide = decide;
      evaluator.active = [typeCode];
      claimFacts.published = {
        productId: PRODUCT,
        productRevisionId: id<'ProductRevision'>(0xd001),
        revisionPublished: true,
        variantIds: [id<'Variant'>(0x6001)],
        platformCategoryPaths: [],
      };
    };

    it('adds a tag: 201 with the type, status and basis only, and logs the outcome', async () => {
      arm();
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());
      const response = await withMarket(http().post(tagsUrl), sessionOf(code)).send({ typeCode });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ typeCode, status: 'active', basis: 'SELLER' });
      expect(savedEdits).toHaveLength(1);
      expect(savedEdits[0]!.tags[0]).toMatchObject({ typeCode, status: 'active' });
      expect(
        logLines.find((l) => l.msg === 'catalog.own-offer-add-tag' && l.code === 'added'),
      ).toBeDefined();
    });

    it('answers 422 with the reason per type, 503 when unanswered, 400 for a client badge', async () => {
      arm((q) => refusedDecision(q, 'no-certificate'));
      await boot();
      await seeded(code);
      offer = Offer.restore(offerState());
      const session = sessionOf(code);
      const refused = await withMarket(http().post(tagsUrl), session).send({ typeCode });
      expect(refused.status).toBe(422);
      expect(refused.body).toEqual({
        statusCode: 422,
        code: 'claim.tag-not-allowed',
        details: { tags: [{ typeCode, reason: 'no-certificate' }] },
      });
      evaluator.unavailable = true;
      const down = await withMarket(http().post(tagsUrl), session).send({ typeCode });
      expect(down.status).toBe(503);
      expect(down.body).toEqual({ statusCode: 503, code: 'claim.check-unavailable' });
      const forged = await withMarket(http().post(tagsUrl), session).send({
        typeCode,
        badge: { reviewedByPlatform: true },
      });
      expect(forged.status).toBe(400);
      const unknown = await withMarket(http().post(tagsUrl), session).send({
        typeCode: 'other-type',
      });
      expect(unknown.status).toBe(422);
      expect(unknown.body).toEqual({ statusCode: 422, code: 'tag.type-unknown' });
      expect(savedEdits).toHaveLength(0);
    });

    it('removes an active tag with 204, refuses a suspended one with 409 and needs CSRF', async () => {
      arm();
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      offer = Offer.restore(offerState(), [
        activeTagState(id<'OfferTag'>(0x5001), typeCode, certificate, START),
      ]);
      expect(
        (
          await withMarket(http().delete(`${tagsUrl}/${typeCode}`), {
            cookie: session.cookie,
          }).send()
        ).status,
      ).toBe(403);
      const removed = await withMarket(http().delete(`${tagsUrl}/${typeCode}`), session).send();
      expect(removed.status).toBe(204);
      expect(savedEdits[0]!.tags[0]!.status).toBe('removed');
      offer = Offer.restore(offerState(), [
        activeTagState(id<'OfferTag'>(0x5002), typeCode, certificate, START, {
          status: 'suspended',
          badge: null,
          lastReasonCode: 'certificate-expired',
          changeSeq: 2,
        }),
      ]);
      const suspended = await withMarket(http().delete(`${tagsUrl}/${typeCode}`), session).send();
      expect(suspended.status).toBe(409);
      expect(suspended.body).toEqual({ statusCode: 409, code: 'tag.suspended' });
      const missing = await withMarket(http().delete(`${tagsUrl}/other-type`), session).send();
      expect(missing.status).toBe(404);
    });

    it('sells without a suspended badge on an explicit confirmation (204), and logs the outcome', async () => {
      arm();
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      const url = `${tagsUrl}/${typeCode}/sell-without-badge`;
      const suspendedTag = () =>
        activeTagState(id<'OfferTag'>(0x5003), typeCode, certificate, START, {
          status: 'suspended',
          badge: null,
          lastReasonCode: 'certificate-revoked',
          changeSeq: 2,
        });
      offer = Offer.restore(offerState({ offSaleCauses: ['tag-suspended'], listed: false }), [
        suspendedTag(),
      ]);
      expect(
        (
          await withMarket(http().post(url), { cookie: session.cookie }).send({
            confirmSellWithoutBadge: true,
          })
        ).status,
      ).toBe(403);
      const unconfirmed = await withMarket(http().post(url), session).send({
        confirmSellWithoutBadge: false,
      });
      expect(unconfirmed.status).toBe(400);
      const missing = await withMarket(http().post(url), session).send({});
      expect(missing.status).toBe(400);
      expect(savedEdits).toHaveLength(0);

      const sold = await withMarket(http().post(url), session).send({
        confirmSellWithoutBadge: true,
      });
      expect(sold.status).toBe(204);
      expect(savedEdits[0]!.tags[0]).toMatchObject({
        status: 'removed',
        lastChangeCause: 'seller-remove-suspended',
      });
      expect(savedEdits[0]!.state).toMatchObject({ offSaleCauses: [], listed: true });
      expect(
        logLines.find(
          (l) => l.msg === 'catalog.own-offer-remove-suspended-tag' && l.code === 'removed',
        ),
      ).toBeDefined();

      offer = Offer.restore(offerState(), [
        activeTagState(id<'OfferTag'>(0x5004), typeCode, certificate, START),
      ]);
      const active = await withMarket(http().post(url), session).send({
        confirmSellWithoutBadge: true,
      });
      expect(active.status).toBe(409);
      expect(active.body).toEqual({ statusCode: 409, code: 'tag.not-suspended' });
    });

    it('takes requestedTags on submit and refuses an unknown key in the body', async () => {
      arm();
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      offer = Offer.restore(
        offerState({ status: 'draft', listed: false, submittedAt: null, firstPublishedAt: null }),
      );
      const bad = await withMarket(
        http().post(`/catalog/seller/offers/${OFFER}/submit`),
        session,
      ).send({
        requestedTags: [typeCode],
        basis: 'SELLER',
      });
      expect(bad.status).toBe(400);
      const submitted = await withMarket(
        http().post(`/catalog/seller/offers/${OFFER}/submit`),
        session,
      ).send({ requestedTags: [typeCode] });
      expect(submitted.status).toBe(200);
      expect(savedEdits.at(-1)!.tags).toEqual([
        expect.objectContaining({ typeCode, status: 'active' }),
      ]);
    });

    it('records and withdraws the attestation of an own Offer, asking every tag again', async () => {
      // Allowed only with the attestation, as a manufacturer basis would be.
      arm((q) =>
        q.attestationRecorded
          ? allowedDecision(q, certificate)
          : refusedDecision(q, 'attestation-missing'),
      );
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      const path = `/catalog/seller/offers/${OFFER}/attestation`;
      const put = (payload: unknown, headers: Record<string, string>) =>
        withMarket(http().put(path), headers).send(payload as object);
      offer = Offer.restore(
        offerState({ status: 'draft', listed: false, firstPublishedAt: null, submittedAt: null }),
      );

      const recorded = await put({ attested: true }, session);
      expect(recorded.status).toBe(200);
      expect(recorded.body).toEqual({
        changedFields: ['attestation'],
        attestationRecordedAt: clock.now().toString(),
      });
      expect(savedEdits[0]!.state).toMatchObject({
        attestationRecordedAt: clock.now(),
        attestationAccountId: OWNER,
      });
      expect(savedEdits[0]!.pendingHistory?.changeKind).toBe('attestation-recorded');
      expect(
        logLines.find(
          (l) => l.msg === 'catalog.own-offer-record-attestation' && l.outcome === 'ok',
        ),
      ).toMatchObject({
        marketId: code,
        correlationId: recorded.headers['x-correlation-id'] as string,
      });

      // Withdrawn on a published Offer: its tag is asked again and suspended.
      offer = Offer.restore(
        offerState({ attestationRecordedAt: START, attestationAccountId: OWNER }),
        [activeTagState(id<'OfferTag'>(0x5101), typeCode, certificate, START)],
      );
      const withdrawn = await put({ attested: false }, session);
      expect(withdrawn.status).toBe(200);
      expect(withdrawn.body).toEqual({
        changedFields: ['attestation'],
        attestationRecordedAt: null,
      });
      expect(savedEdits[1]!.tags[0]).toMatchObject({
        status: 'suspended',
        lastReasonCode: 'attestation-missing',
        lastChangeCause: 'attestation-change',
      });
      expect(savedEdits[1]!.state).toMatchObject({ listed: false, attestationRecordedAt: null });

      // Unanswered: refused, nothing stored.
      evaluator.unavailable = true;
      offer = Offer.restore(
        offerState({ attestationRecordedAt: START, attestationAccountId: OWNER }),
        [activeTagState(id<'OfferTag'>(0x5102), typeCode, certificate, START)],
      );
      const down = await put({ attested: false }, session);
      expect(down.status).toBe(503);
      expect(down.body).toEqual({ statusCode: 503, code: 'claim.check-unavailable' });
      expect(savedEdits).toHaveLength(2);
    });

    it('refuses the attestation without CSRF, a session or the seller origin, a bad body, another handling and a stranger’s Offer', async () => {
      arm();
      await boot();
      await seeded(code);
      const session = sessionOf(code);
      const path = `/catalog/seller/offers/${OFFER}/attestation`;
      const put = (payload: unknown, headers: Record<string, string>) =>
        withMarket(http().put(path), headers).send(payload as object);
      offer = Offer.restore(offerState());

      expect((await put({ attested: true }, { cookie: session.cookie })).status).toBe(403);
      expect((await put({ attested: true }, {})).status).toBe(401);
      for (const body of [
        {},
        { attested: 'yes' },
        { attested: true, attestationAccountId: OWNER },
        { attested: true, attestationRecordedAt: START.toString() },
        { attested: true, handling: 'SEALED_ORIGINAL' },
      ]) {
        expect((await put(body, session)).status).toBe(400);
      }
      const wrongOrigin = await http()
        .put(path)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
        .send({ attested: true });
      expect(wrongOrigin.status).toBe(403);
      const crossSite = await http()
        .put(path)
        .set({
          'x-market-id': code,
          ...panelHeaders(code, 'seller'),
          ...session,
          'sec-fetch-site': 'cross-site',
        })
        .send({ attested: true });
      expect(crossSite.status).toBe(403);

      offer = Offer.restore(offerState({ handling: 'REPACKED' }));
      const repacked = await put({ attested: true }, session);
      expect(repacked.status).toBe(422);
      expect(repacked.body).toEqual({
        statusCode: 422,
        code: 'offer.attestation-needs-sealed-original',
      });
      offer = Offer.restore(offerState({ sellerId: id<'Seller'>(0xb999) }));
      expect((await put({ attested: true }, session)).body).toEqual({
        statusCode: 404,
        code: 'offer.not-found',
      });
      expect(savedEdits).toHaveLength(0);
    });

    it('documents the tag routes in OpenAPI', async () => {
      await boot({ API_DOCS_ENABLED: 'true' });
      const document = (await http().get('/docs-json').expect(200)).body as {
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      };
      const add = document.paths['/catalog/seller/offers/{offerId}/tags']?.post?.responses;
      for (const status of ['201', '400', '403', '404', '409', '422', '429', '503']) {
        expect(add).toHaveProperty(status);
      }
      const remove =
        document.paths['/catalog/seller/offers/{offerId}/tags/{typeCode}']?.delete?.responses;
      for (const status of ['204', '400', '403', '404', '409']) {
        expect(remove).toHaveProperty(status);
      }
      const sellWithoutBadge =
        document.paths['/catalog/seller/offers/{offerId}/tags/{typeCode}/sell-without-badge']?.post
          ?.responses;
      for (const status of ['204', '400', '403', '404', '409', '415', '503']) {
        expect(sellWithoutBadge).toHaveProperty(status);
      }
      const attestation =
        document.paths['/catalog/seller/offers/{offerId}/attestation']?.put?.responses;
      for (const status of ['200', '400', '401', '403', '404', '409', '415', '422', '429', '503']) {
        expect(attestation).toHaveProperty(status);
      }
    });
  });
  describe.each(TEST_MARKETS)('sell units in market %s', (code) => {
    const OFFER = id<'Offer'>(0x9101);
    const V1 = id<'Variant'>(0xa101);
    const V2 = id<'Variant'>(0xa102);
    const url = `/catalog/seller/offers/${OFFER}/sell-units`;
    const put = (path: string, payload: unknown, headers: Record<string, string>) =>
      http()
        .put(path)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers })
        .send(payload as object);
    const ownOffer = (overrides: Partial<OfferState> = {}) =>
      Offer.restore({
        id: OFFER,
        marketId: code as AccountState['marketId'],
        sellerId: SELLER,
        productId: PRODUCT,
        sellerSku: 'SKU-1',
        conditionCode: 'new',
        description: {},
        handling: null,
        attestationRecordedAt: null,
        attestationAccountId: null,
        status: 'draft',
        offSaleCauses: [],
        listed: false,
        submittedAt: null,
        firstPublishedAt: null,
        deletedAt: null,
        version: 2,
        createdAt: START,
        ...overrides,
      });
    const rows = () => [
      { variantId: V1, variantNo: 1, variantSku: null, selling: true },
      { variantId: V2, variantNo: 2, variantSku: null, selling: true },
    ];

    it('turns a unit off sale and answers the changed variant ids', async () => {
      await boot();
      await seeded(code);
      offer = ownOffer();
      sellUnitRows = rows();
      const answer = await put(
        url,
        { units: [{ variantId: V2, selling: false }] },
        sessionOf(code),
      );
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ changedVariantIds: [V2] });
      expect(sellUnitSaves).toHaveLength(1);
    });

    it('refuses without the CSRF token and without a session', async () => {
      await boot();
      await seeded(code);
      offer = ownOffer();
      sellUnitRows = rows();
      const session = sessionOf(code);
      const body = { units: [{ variantId: V2, selling: false }] };
      expect((await put(url, body, { cookie: session.cookie })).body).toEqual({
        statusCode: 403,
        code: 'request.csrf',
      });
      expect((await put(url, body, {})).status).toBe(401);
      expect(sellUnitSaves).toHaveLength(0);
    });

    it('refuses an unknown field, an unknown variant and an empty list', async () => {
      await boot();
      await seeded(code);
      offer = ownOffer();
      sellUnitRows = rows();
      const session = sessionOf(code);
      const extra = await put(url, { units: [], handling: 'FRESH' }, session);
      expect(extra.status).toBe(400);
      expect(extra.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'handling', code: 'unknown-field' }] },
      });
      expect((await put(url, { units: [] }, session)).status).toBe(400);
      const unknown = await put(
        url,
        { units: [{ variantId: id<'Variant'>(0xa1ff), selling: false }] },
        session,
      );
      expect(unknown.status).toBe(400);
      expect(sellUnitSaves).toHaveLength(0);
    });

    it('maps the refusals: last unit 422, taken SKU 409, spent budget 429', async () => {
      await boot();
      await seeded(code);
      offer = ownOffer();
      sellUnitRows = rows();
      const session = sessionOf(code);
      const last = await put(
        url,
        {
          units: [
            { variantId: V1, selling: false },
            { variantId: V2, selling: false },
          ],
        },
        session,
      );
      expect(last.status).toBe(422);
      expect(last.body).toMatchObject({ code: 'offer.none-selling' });
      sellUnitRefusal = 'offer.sku-taken';
      const taken = await put(url, { units: [{ variantId: V1, variantSku: 'DUP' }] }, session);
      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({ code: 'offer.sku-taken' });
      reserve = { code: 'request.throttled', retryAfterSeconds: 30 };
      const throttled = await put(url, { units: [{ variantId: V1, selling: false }] }, session);
      expect(throttled.status).toBe(429);
    });

    const get = (headers: Record<string, string>) =>
      http()
        .get(url)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers });

    it('reads the sell units: scope, SKU, codes, labels, switch and SKU, in variant order', async () => {
      await boot();
      await seeded(code);
      offer = ownOffer();
      sellUnitRows = [
        { variantId: V2, variantNo: 2, variantSku: 'PK-2', selling: false },
        { variantId: V1, variantNo: 1, variantSku: null, selling: true },
      ];
      const answer = await get({ cookie: sessionOf(code).cookie });
      expect(answer.status).toBe(200);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.body).toEqual({
        productScope: 'PLATFORM',
        sellerSku: 'SKU-1',
        units: [
          {
            variantId: V1,
            variantNo: 1,
            variantCode: 'MP-000123-01',
            state: 'published',
            label: 'Small',
            selling: true,
            variantSku: null,
            displaySku: 'SKU-1-1',
          },
          {
            variantId: V2,
            variantNo: 2,
            variantCode: 'MP-000123-02',
            state: 'published',
            label: null,
            selling: false,
            variantSku: 'PK-2',
            displaySku: 'PK-2',
          },
        ],
      });
      expect((await get({})).status).toBe(401);
    });

    it('refuses the read with 403 for a seller without catalog.own-product.view', async () => {
      await boot();
      await seeded(code);
      offer = ownOffer();
      sellUnitRows = rows();
      fakes.assignments.clear();
      const answer = await get({ cookie: sessionOf(code).cookie });
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ code: 'access.denied' });
    });

    it('answers a bad id and every Offer that is not the seller’s to read with the same 404 body', async () => {
      await boot();
      await seeded(code);
      sellUnitRows = rows();
      const bodies: string[] = [];
      for (const found of [
        null,
        ownOffer({ sellerId: id<'Seller'>(0xb999) }),
        ownOffer({ status: 'deleted', deletedAt: START }),
      ]) {
        offer = found;
        const answer = await get({ cookie: sessionOf(code).cookie });
        expect(answer.status).toBe(404);
        bodies.push(JSON.stringify(answer.body));
      }
      const bad = await http()
        .get('/catalog/seller/offers/not-an-id/sell-units')
        .set({
          'x-market-id': code,
          ...panelHeaders(code, 'seller'),
          cookie: sessionOf(code).cookie,
        });
      expect(bad.status).toBe(404);
      bodies.push(JSON.stringify(bad.body));
      expect(new Set(bodies).size).toBe(1);
    });

    it('answers every Offer that is not the seller’s with the same 404 body', async () => {
      await boot();
      await seeded(code);
      sellUnitRows = rows();
      const session = sessionOf(code);
      const bodies: string[] = [];
      for (const found of [
        null,
        ownOffer({ sellerId: id<'Seller'>(0xb999) }),
        ownOffer({ status: 'deleted', deletedAt: START }),
      ]) {
        offer = found;
        const answer = await put(url, { units: [{ variantId: V1, selling: false }] }, session);
        expect(answer.status).toBe(404);
        bodies.push(JSON.stringify(answer.body));
      }
      expect(new Set(bodies).size).toBe(1);
      expect(sellUnitSaves).toHaveLength(0);
    });
  });
});
