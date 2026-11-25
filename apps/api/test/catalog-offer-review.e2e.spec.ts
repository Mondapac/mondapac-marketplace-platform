import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Id,
  MarketContext,
  MarketId,
  PendingEvent,
} from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CheckClaimText } from '../src/modules/catalog/application/claim-text/check-claim-text.service';
import { ALLOWED_PRODUCT_TYPES_READER } from '../src/modules/catalog/application/ports/allowed-product-types.reader';
import { CLAIM_EVALUATOR } from '../src/modules/catalog/application/ports/claim-evaluator';
import { OFFER_PENDING_CHANGE_REPOSITORY } from '../src/modules/catalog/application/ports/offer-pending-change.repository';
import { OFFER_REPOSITORY } from '../src/modules/catalog/application/ports/offer.repository';
import { SELLER_OFFER_REVIEW_FLAGS_READER } from '../src/modules/catalog/application/ports/seller-offer-review-flags.reader';
import { OFFER_REVIEW_QUEUE_FACTS } from '../src/modules/catalog/application/ports/offer-review';
import { CATEGORY_OFFER_REVIEW_FLAGS_STORE } from '../src/modules/catalog/application/ports/category-offer-review-flags.store';
import { OFFER_REVIEW_STOPS_READER } from '../src/modules/catalog/application/ports/offer-review-stops.reader';
import type { OfferReviewReason } from '../src/modules/catalog/domain/offer-review-policy';
import { SELLER_REVIEW_STANDING_REPOSITORY } from '../src/modules/catalog/application/ports/seller-review-standing.repository';
import { ClaimQueryBuilder } from '../src/modules/catalog/application/tags/claim-query-builder';
import { OfferPendingChange } from '../src/modules/catalog/domain/offer-pending-change';
import { AUDIT_WRITER } from '../src/platform/audit/audit-writer';
import type { OfferActor } from '../src/modules/catalog/application/ports/offer.repository';
import { OWN_CATALOG_READER } from '../src/modules/catalog/application/ports/own-catalog.reader';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import { SELLER_NAMES_READER } from '../src/modules/catalog/application/ports/seller-names.reader';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { StaleAggregateError } from '../src/platform/unit-of-work/errors';
import { Offer, type OfferState } from '../src/modules/catalog/domain/offer';
import { Product, type ProductState } from '../src/modules/catalog/domain/product';
import { OFFER_REVIEW_STATUS } from '../src/modules/catalog/presentation/offer-review.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { InMemoryOfferPendingChanges } from './support/catalog-offer-edit-review-fakes';
import { FLAGS_OFF, InMemorySellerReviewStandings } from './support/catalog-seller-review-fakes';
import {
  FakeClaimEvaluator,
  FixedFactsClaimQueryBuilder,
  refusedDecision,
} from './support/catalog-tag-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The Offer review queue over HTTP (catalog design 4.4, 8.2, 9.2): the real guards, controller,
// gate and use cases, with identity's ports and catalog's stores as in-memory fakes. Proved here:
// the admin session and CSRF token, the two keys (the seeded Moderator and Viewer roles), the
// closed bodies, the status of each refusal, no-store, and what a decision stores.

const START = Temporal.Instant.from('2026-10-14T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MODERATOR = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const NO_KEY = id<'Account'>(0xa003);
const NO_KEY_ROLE = id<'Role'>(0xc0f2);
const SELLER = id<'Seller'>(0xb020);
const PRODUCT = id<'Product'>(0xc001);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the review use cases to its exact status', () => {
  expect(OFFER_REVIEW_STATUS).toEqual({
    'validation.failed': 400,
    'offer.not-found': 404,
    'offer.not-pending-review': 409,
    'offer.product-not-published': 409,
    'seller.not-eligible': 409,
    'type.not-allowed': 409,
    'conflict.stale': 409,
    'conflict.retry': 409,
    'claim-text.refused': 422,
    'batch.too-large': 413,
    'access.unavailable': 503,
    'claim.check-unavailable': 503,
    'offer-change.not-found': 404,
    'offer-change.not-pending': 409,
    'offer-change.own-submission': 403,
    'offer-change.invalid': 422,
    'claim.tag-not-allowed': 422,
  });
});

describe('admin Offer review over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let offers: Map<string, Offer>;
  let saved: { offer: Offer; actor: OfferActor }[];
  let events: PendingEvent[];
  let productStatus: ProductState['status'];
  let eligible: boolean;
  let claimVerdict: 'clean' | 'claim-text.found';
  let saveThrows: Error | null;
  let allowed: 'all' | Set<string>;
  let pendingChanges: InMemoryOfferPendingChanges;
  let audits: { action: string }[];
  let evaluator: FakeClaimEvaluator;
  let claimFacts: FixedFactsClaimQueryBuilder;
  let standings: InMemorySellerReviewStandings;
  /** The first-publication reasons and tag types of Offers (the queue's chips, slice 5). */
  let firstReasons: Map<string, readonly OfferReviewReason[]>;
  let tagTypes: Map<string, readonly string[]>;
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
          .overrideProvider(OUTBOX_WRITER)
          .useValue({
            append: (_c: CallContext, pending: readonly PendingEvent[]) => {
              events.push(...pending);
              return Promise.resolve();
            },
          })
          .overrideProvider(OFFER_REPOSITORY)
          .useValue({
            findById: (_m: MarketContext, offerId: Id<'Offer'>) =>
              Promise.resolve(
                offers.has(offerId) ? Offer.restore(offers.get(offerId)!.state) : null,
              ),
            findManyByIds: (_m: MarketContext, wanted: readonly Id<'Offer'>[]) =>
              Promise.resolve(
                wanted.flatMap((offerId) =>
                  offers.has(offerId) ? [Offer.restore(offers.get(offerId)!.state)] : [],
                ),
              ),
            save: (_m: MarketContext, offer: Offer, actor: OfferActor) => {
              if (saveThrows !== null) return Promise.reject(saveThrows);
              saved.push({ offer, actor });
              offers.set(offer.state.id, Offer.restore(offer.state));
              return Promise.resolve(null);
            },
            listPendingReview: (
              _m: MarketContext,
              page: { after: { submittedAt: Temporal.Instant; id: string } | null; limit: number },
            ) => {
              const waiting = [...offers.values()]
                .filter((o) => o.state.status === 'pending-first-publish')
                .sort(
                  (a, b) =>
                    a.state.submittedAt!.epochMilliseconds - b.state.submittedAt!.epochMilliseconds,
                );
              const from =
                page.after === null
                  ? 0
                  : waiting.findIndex((o) => o.state.id === page.after!.id) + 1;
              return Promise.resolve(waiting.slice(from, from + page.limit));
            },
          })
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({
            findById: (_m: MarketContext, productId: Id<'Product'>) =>
              Promise.resolve(productId === PRODUCT ? productOf(productStatus) : null),
          })
          .overrideProvider(OWN_CATALOG_READER)
          .useValue({
            pendingReviewCount: () => Promise.resolve(1),
            pendingRevisionCount: () => Promise.resolve(0),
            listPendingRevisions: () => Promise.resolve([]),
            productLabels: () =>
              Promise.resolve([
                { productId: PRODUCT, productCode: 'P00000001', typeCode: 'simple', name: 'Dates' },
              ]),
          })
          .overrideProvider(SELLER_NAMES_READER)
          .useValue({
            storeNames: () => Promise.resolve(new Map([[SELLER, 'Dates Co']])),
          })
          .overrideProvider(ALLOWED_PRODUCT_TYPES_READER)
          .useValue({ allowedFor: () => Promise.resolve(allowed) })
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(eligible) })
          .overrideProvider(OFFER_PENDING_CHANGE_REPOSITORY)
          .useValue(pendingChanges)
          .overrideProvider(SELLER_REVIEW_STANDING_REPOSITORY)
          .useValue(standings)
          .overrideProvider(SELLER_OFFER_REVIEW_FLAGS_READER)
          .useValue({ flagsOf: () => Promise.resolve(FLAGS_OFF) })
          .overrideProvider(OFFER_REVIEW_QUEUE_FACTS)
          .useValue({
            firstPublicationReasons: (_m: MarketContext, wanted: readonly string[]) =>
              Promise.resolve(
                new Map(
                  wanted.flatMap((offerId) =>
                    firstReasons.has(offerId) ? [[offerId, firstReasons.get(offerId)!]] : [],
                  ),
                ),
              ),
            openTagTypes: (_m: MarketContext, wanted: readonly string[]) =>
              Promise.resolve(
                new Map(wanted.map((offerId) => [offerId, tagTypes.get(offerId) ?? []])),
              ),
          })
          .overrideProvider(CATEGORY_OFFER_REVIEW_FLAGS_STORE)
          .useValue({
            listFlagged: () =>
              Promise.resolve([
                { categoryId: PRODUCT, alwaysReview: true, reviewStop: true, version: 1 },
                { categoryId: SELLER, alwaysReview: true, reviewStop: false, version: 1 },
              ]),
          })
          .overrideProvider(OFFER_REVIEW_STOPS_READER)
          .useValue({
            marketStop: () => Promise.resolve(true),
            stoppedSellerCount: () => Promise.resolve(2),
          })
          .overrideProvider(AUDIT_WRITER)
          .useValue({
            record: (_c: unknown, entry: { action: string }) => {
              audits.push(entry);
              return Promise.resolve();
            },
          })
          .overrideProvider(CLAIM_EVALUATOR)
          .useValue(evaluator)
          .overrideProvider(ClaimQueryBuilder)
          .useValue(claimFacts)
          .overrideProvider(CheckClaimText)
          .useValue({
            execute: (_c: CallContext, texts: readonly { locale: string }[]) =>
              Promise.resolve({
                ok: true,
                value: texts.map((t) =>
                  claimVerdict === 'clean'
                    ? { code: 'clean', field: 'offer.description', ref: null, locale: t.locale }
                    : {
                        code: 'claim-text.found',
                        field: 'offer.description',
                        ref: null,
                        locale: t.locale,
                        hits: [],
                      },
                ),
              }),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const productOf = (status: ProductState['status']) =>
    Product.restore({
      id: PRODUCT,
      marketId: 'AU' as AccountState['marketId'],
      scope: 'PLATFORM',
      ownerSellerId: null,
      createdBySellerId: null,
      typeCode: 'simple',
      variantModel: 'single',
      familyCode: 'default',
      productCode: 'P00000001',
      status,
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

  /** A waiting Offer; `n` orders the queue (a larger n was submitted later). */
  function waiting(code: string, n: number, overrides: Partial<OfferState> = {}): Offer {
    const offer = Offer.restore({
      id: id<'Offer'>(0x9000 + n),
      marketId: code as AccountState['marketId'],
      sellerId: SELLER,
      productId: PRODUCT,
      sellerSku: `SKU-${n}`,
      conditionCode: 'new',
      description: { 'en-AU': 'Fresh dates' },
      handling: 'SEALED_ORIGINAL',
      attestationRecordedAt: null,
      attestationAccountId: null,
      status: 'pending-first-publish',
      offSaleCauses: [],
      listed: false,
      submittedAt: START.add({ minutes: n }),
      firstPublishedAt: null,
      deletedAt: null,
      version: 4,
      createdAt: START,
      ...overrides,
    });
    offers.set(offer.state.id, offer);
    return offer;
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'review-0001'), {});
    const marketId = code as AccountState['marketId'];
    fakes.seedRole({
      id: NO_KEY_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'No catalog key',
      permissionKeys: ['identity.admin-account.view'],
      version: 1,
      createdAt: START,
    });
    const seedRole = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    let n = 0;
    const admin = (accountId: Id<'Account'>, label: string, roleId: Id<'Role'>) => {
      n += 1;
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'admin',
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: `Name ${label}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe000 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(MODERATOR, 'moderator', seedRole('catalogue-moderator'));
    admin(VIEWER, 'viewer', seedRole('viewer'));
    admin(NO_KEY, 'nokey', NO_KEY_ROLE);
  }

  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const base = (code: string) => ({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
  const get = (code: string, path: string, session: Record<string, string> | null) =>
    http()
      .get(`/catalog/admin${path}`)
      .set({ ...base(code), ...(session === null ? {} : { cookie: session.cookie! }) });
  const post = (code: string, path: string, session: Record<string, string>, payload?: unknown) =>
    http()
      .post(`/catalog/admin${path}`)
      .set({ ...base(code), ...session })
      .send(payload ?? {});

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    offers = new Map();
    saved = [];
    events = [];
    productStatus = 'published';
    eligible = true;
    claimVerdict = 'clean';
    saveThrows = null;
    allowed = 'all';
    pendingChanges = new InMemoryOfferPendingChanges();
    audits = [];
    evaluator = new FakeClaimEvaluator(() => {
      throw new Error('no claim was expected');
    }, []);
    claimFacts = new FixedFactsClaimQueryBuilder(null);
    standings = new InMemorySellerReviewStandings();
    firstReasons = new Map();
    tagTypes = new Map();
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the three routes and their error codes in OpenAPI', async () => {
    await boot();
    const document = (await createDocs()).paths;
    expect(document['/catalog/admin/review-queue']?.get?.responses).toHaveProperty('403');
    for (const route of ['approve', 'request-changes']) {
      const responses = document[`/catalog/admin/offers/{offerId}/${route}`]?.post?.responses;
      for (const status of ['200', '400', '403', '404', '409', '503']) {
        expect(responses).toHaveProperty(status);
      }
    }
    expect(document['/catalog/admin/offer-changes']?.get?.responses).toHaveProperty('403');
    // Slice 5: the Edits list's export, one change by id and the stop banner's counts.
    expect(document['/catalog/admin/offer-changes/export']?.get?.responses).toHaveProperty('413');
    expect(document['/catalog/admin/offer-changes/{changeId}']?.get?.responses).toHaveProperty(
      '404',
    );
    expect(document['/catalog/admin/offer-review/stops']?.get?.responses).toHaveProperty('200');
    for (const route of ['approve', 'request-changes', 'reject']) {
      const responses =
        document[`/catalog/admin/offer-changes/{changeId}/${route}`]?.post?.responses;
      for (const status of ['200', '400', '403', '404', '409']) {
        expect(responses).toHaveProperty(status);
      }
    }
  }, 30_000);

  async function createDocs() {
    await app.close();
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
    return (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
  }

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the waiting Offers oldest first for the Viewer, no-store, with the product label', async () => {
      await boot();
      await seeded(code);
      const later = waiting(code, 9);
      const earlier = waiting(code, 1);
      waiting(code, 2, { status: 'draft', submittedAt: null, handling: null });
      firstReasons.set(earlier.state.id, ['probation', 'certificate-badge']);
      tagTypes.set(earlier.state.id, [code === 'AU' ? 'halal' : 'zz-cert']);

      const response = await get(code, '/review-queue', sessionOf(code, VIEWER, 1));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as { items: Record<string, unknown>[]; nextAfterId: unknown };
      expect(body.items.map((i) => i.offerId)).toEqual([earlier.state.id, later.state.id]);
      expect(body.nextAfterId).toBeNull();
      expect((response.body as { total: unknown }).total).toBe(1);
      expect(body.items[0]).toMatchObject({
        kind: 'offer-first-publication',
        version: 4,
        sellerId: SELLER,
        storeName: 'Dates Co',
        product: { productCode: 'P00000001', typeCode: 'simple', name: 'Dates' },
        handling: 'SEALED_ORIGINAL',
        reasons: ['probation', 'certificate-badge'],
        tagTypes: [code === 'AU' ? 'halal' : 'zz-cert'],
      });
      expect(body.items[1]).toMatchObject({ reasons: [], tagTypes: [] });
    });

    it('pages the queue with limit and afterId, and refuses a bad cursor and limit', async () => {
      await boot();
      await seeded(code);
      waiting(code, 1);
      waiting(code, 2);
      const session = sessionOf(code, VIEWER, 1);

      const first = await get(code, '/review-queue?limit=1', session);
      const cursor = (first.body as { nextAfterId: string }).nextAfterId;
      expect(cursor).toEqual(expect.any(String));
      const second = await get(code, `/review-queue?limit=1&afterId=${cursor}`, session);
      expect((second.body as { items: unknown[] }).items).toHaveLength(1);
      expect((second.body as { nextAfterId: unknown }).nextAfterId).toBeNull();
      expect((await get(code, '/review-queue?afterId=nope', session)).status).toBe(400);
      expect((await get(code, '/review-queue?limit=0', session)).status).toBe(400);
    });

    it('exports the queue as CSV and XLSX with the list filters, and refuses a bad request', async () => {
      await boot();
      await seeded(code);
      waiting(code, 9);
      waiting(code, 1);
      const session = sessionOf(code, VIEWER, 1);

      const csv = await get(code, '/review-queue/export', session).buffer(true);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toMatch(
        /^attachment; filename="review-queue-.*\.csv"$/,
      );
      expect(csv.headers['cache-control']).toBe('no-store');
      const lines = csv.text.replace('\uFEFF', '').trim().split(/\r?\n/);
      expect(lines[0]).toBe(
        'kind,product_code,product_name,seller_id,store_name,seller_sku,first_publication,reasons,required_checks,has_images,warnings,submitted_at',
      );
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('offer-first-publication,P00000001,Dates');
      const kinds = await get(code, '/review-queue/export?kind=product-revision', session).buffer(
        true,
      );
      expect(kinds.text.replace('\uFEFF', '').trim().split(/\r?\n/)).toHaveLength(1);
      const xlsx = await get(code, '/review-queue/export?format=xlsx', session).buffer(true);
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      expect((await get(code, '/review-queue/export?format=pdf', session)).status).toBe(400);
      expect((await get(code, '/review-queue/export?page=2', session)).status).toBe(400);
      expect((await get(code, '/review-queue/export?direction=desc', session)).status).toBe(400);
      expect((await get(code, '/review-queue/export', null)).status).toBe(401);
      expect((await get(code, '/review-queue/export', sessionOf(code, NO_KEY, 3))).status).toBe(
        403,
      );
    });

    it('answers 401 without a session and 403 without the view key', async () => {
      await boot();
      await seeded(code);

      expect((await get(code, '/review-queue', null)).status).toBe(401);
      expect((await get(code, '/review-queue', sessionOf(code, NO_KEY, 3))).status).toBe(403);
    });

    it('approves with the approve key: published, listed, admin actor, event, no other change', async () => {
      await boot();
      await seeded(code);
      const offer = waiting(code, 1);

      const response = await post(
        code,
        `/offers/${offer.state.id}/approve`,
        sessionOf(code, MODERATOR, 1),
        { version: 4 },
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
      expect(saved).toHaveLength(1);
      expect(saved[0]!.actor).toEqual({ kind: 'admin', accountId: MODERATOR });
      expect(saved[0]!.offer.state).toMatchObject({
        status: 'published',
        listed: true,
        version: 5,
        firstPublishedAt: START,
        sellerId: SELLER,
      });
      expect(saved[0]!.offer.pendingHistory).toMatchObject({ changeKind: 'publication-approved' });
      expect(events.map((e) => e.type)).toEqual(['catalog.offer-published.v1']);
      // The approval counts toward the seller's probation, in the decision's unit (slice 4).
      expect(standings.credits).toEqual([
        expect.objectContaining({
          sellerId: SELLER,
          epoch: 1,
          offerId: offer.state.id,
          marketId: code,
        }),
      ]);
    });

    it('refuses a decision from a Viewer or a holder of no key, storing nothing', async () => {
      await boot();
      await seeded(code);
      const offer = waiting(code, 1);

      for (const [account, n] of [
        [VIEWER, 1],
        [NO_KEY, 2],
      ] as const) {
        const session = sessionOf(code, account, n);
        expect(
          (await post(code, `/offers/${offer.state.id}/approve`, session, { version: 4 })).status,
        ).toBe(403);
        expect(
          (
            await post(code, `/offers/${offer.state.id}/request-changes`, session, {
              version: 4,
              reasonCode: 'other',
            })
          ).status,
        ).toBe(403);
      }
      expect(saved).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it('answers 404, 409 and 422 with the refusal code and stores nothing', async () => {
      await boot();
      await seeded(code);
      const session = () => sessionOf(code, MODERATOR, 1);
      const offer = waiting(code, 1);
      const draft = waiting(code, 2, { status: 'draft', submittedAt: null, handling: null });
      const approve = (target: Id<'Offer'>, version = 4) =>
        post(code, `/offers/${target}/approve`, session(), { version });

      const unknown = await approve(id<'Offer'>(0x7777));
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ statusCode: 404, code: 'offer.not-found' });
      expect((await approve(draft.state.id)).body).toMatchObject({
        code: 'offer.not-pending-review',
      });
      expect((await approve(offer.state.id, 3)).body).toMatchObject({ code: 'conflict.stale' });
      productStatus = 'unpublished';
      expect((await approve(offer.state.id)).body).toMatchObject({
        code: 'offer.product-not-published',
      });
      productStatus = 'published';
      eligible = false;
      expect((await approve(offer.state.id)).body).toMatchObject({ code: 'seller.not-eligible' });
      eligible = true;
      allowed = new Set<string>();
      expect((await approve(offer.state.id)).body).toMatchObject({ code: 'type.not-allowed' });
      allowed = 'all';
      claimVerdict = 'claim-text.found';
      const refused = await approve(offer.state.id);
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ code: 'claim-text.refused' });
      expect(saved).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it('answers a lost race on the save as 409 conflict.stale, storing and announcing nothing', async () => {
      await boot();
      await seeded(code);
      const offer = waiting(code, 1);
      saveThrows = new StaleAggregateError('offer', offer.state.id);

      const approve = await post(
        code,
        `/offers/${offer.state.id}/approve`,
        sessionOf(code, MODERATOR, 1),
        { version: 4 },
      );
      const changes = await post(
        code,
        `/offers/${offer.state.id}/request-changes`,
        sessionOf(code, MODERATOR, 2),
        { version: 4, reasonCode: 'other' },
      );

      for (const response of [approve, changes]) {
        expect(response.status).toBe(409);
        expect(response.body).toEqual({ statusCode: 409, code: 'conflict.stale' });
      }
      expect(saved).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it('sends an Offer back with a reason code: changes-needed, admin actor, reason on the event', async () => {
      await boot();
      await seeded(code);
      const offer = waiting(code, 1);

      const response = await post(
        code,
        `/offers/${offer.state.id}/request-changes`,
        sessionOf(code, MODERATOR, 1),
        { version: 4, reasonCode: 'description-claim' },
      );

      expect(response.status).toBe(200);
      expect(saved[0]!.actor).toEqual({ kind: 'admin', accountId: MODERATOR });
      expect(saved[0]!.offer.state).toMatchObject({ status: 'changes-needed', version: 5 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'catalog.offer-changes-requested.v1',
        payload: { offerId: offer.state.id, sellerId: SELLER, reasonCode: 'description-claim' },
      });
      // The send-back is one Changes needed in a row of the seller's standing (slice 4).
      expect(standings.rows.get(`${code}|${SELLER}`)).toMatchObject({
        epoch: 1,
        consecutiveChangesNeeded: 1,
      });
      expect(standings.credits).toEqual([]);
    });

    it('refuses a bad reason, an unknown field, a missing version and a bad id, storing nothing', async () => {
      await boot();
      await seeded(code);
      const session = () => sessionOf(code, MODERATOR, 1);
      const offer = waiting(code, 1);
      const path = `/offers/${offer.state.id}/request-changes`;

      const reason = await post(code, path, session(), { version: 4, reasonCode: 'free text' });
      expect(reason.status).toBe(400);
      expect(reason.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'reasonCode', code: 'unknown' }] },
      });
      expect((await post(code, path, session(), { version: 4 })).status).toBe(400);
      expect(
        (await post(code, path, session(), { version: 4, reasonCode: 'other', note: 'x' })).status,
      ).toBe(400);
      expect(
        (await post(code, `/offers/${offer.state.id}/approve`, session(), { version: '4' })).status,
      ).toBe(400);
      expect((await post(code, '/offers/nope/approve', session(), { version: 4 })).status).toBe(
        400,
      );
      expect(saved).toHaveLength(0);
    });

    it('refuses a decision without the CSRF token, without a session and from the seller origin', async () => {
      await boot();
      await seeded(code);
      const offer = waiting(code, 1);
      const session = sessionOf(code, MODERATOR, 1);
      const path = `/catalog/admin/offers/${offer.state.id}/approve`;

      const noCsrf = await http()
        .post(path)
        .set({ ...base(code), cookie: session.cookie })
        .send({ version: 4 });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect((await http().post(path).set(base(code)).send({ version: 4 })).status).toBe(401);
      const sellerOrigin = await http()
        .post(path)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...session })
        .send({ version: 4 });
      expect(sellerOrigin.status).toBe(403);
      expect(saved).toHaveLength(0);
    });
  });

  describe.each(TEST_MARKETS)('held changes of live Offers in market %s (slice 2c)', (code) => {
    const typeCode = code === 'AU' ? 'halal' : 'zz-cert';
    const SELLER_ACCOUNT = id<'Account'>(0xa101);

    /** A live Offer with one held change waiting for a reviewer. */
    function held(
      n: number,
      proposal: {
        readonly proposedDescription?: Record<string, string>;
        readonly proposedHandling?: 'FRESH' | 'REPACKED';
        readonly proposedTagTypes?: readonly string[];
        readonly submittedByAccountId?: Id<'Account'>;
      },
    ) {
      const offer = waiting(code, n, {
        status: 'published',
        listed: true,
        firstPublishedAt: START,
        version: 5,
      });
      const made = OfferPendingChange.propose({
        id: id<'OfferPendingChange'>(0x8000 + n),
        marketId: code as MarketId,
        offerId: offer.state.id,
        sellerId: SELLER,
        baseOfferVersion: 5,
        reasons: ['handling'],
        policyVersion: 2,
        submittedByAccountId: SELLER_ACCOUNT,
        ...proposal,
        now: START.add({ minutes: n }),
      });
      if (!made.ok) throw new Error(made.error.code);
      void pendingChanges.insert(marketOf(code), made.value);
      return { offer, change: made.value };
    }

    it('lists the held changes oldest first for the Viewer, no-store, with the proposal', async () => {
      await boot();
      await seeded(code);
      const later = held(2, { proposedHandling: 'FRESH' });
      const earlier = held(1, { proposedDescription: { 'en-AU': 'New text' } });
      const session = sessionOf(code, VIEWER, 1);

      const response = await get(code, '/offer-changes', session);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as { items: Record<string, unknown>[]; nextAfterId: unknown };
      expect(body.items.map((i) => i.changeId)).toEqual([
        earlier.change.state.id,
        later.change.state.id,
      ]);
      expect(body.items[0]).toMatchObject({
        offerId: earlier.offer.state.id,
        sellerId: SELLER,
        status: 'pending',
        fields: ['description'],
        proposedDescription: { 'en-AU': 'New text' },
        reasons: ['handling'],
      });
      const first = await get(code, '/offer-changes?limit=1', session);
      const cursor = (first.body as { nextAfterId: string }).nextAfterId;
      expect(cursor).toBe(earlier.change.state.id);
      const second = await get(code, `/offer-changes?limit=1&afterId=${cursor}`, session);
      expect((second.body as { items: { changeId: string }[] }).items[0]!.changeId).toBe(
        later.change.state.id,
      );
      expect((await get(code, '/offer-changes?limit=0', session)).status).toBe(400);
      expect((await get(code, '/offer-changes', null)).status).toBe(401);
      expect((await get(code, '/offer-changes', sessionOf(code, NO_KEY, 3))).status).toBe(403);
    });

    it('serves the Edits super list: filters, total, live values, actions per key (slice 5)', async () => {
      await boot();
      await seeded(code);
      const a = held(1, { proposedHandling: 'FRESH' });
      const b = held(2, { proposedDescription: { 'en-AU': 'New text' } });
      pendingChanges.rows.set(b.change.state.id, {
        ...pendingChanges.rows.get(b.change.state.id)!,
        reasons: ['contact-text'],
      });
      const viewer = sessionOf(code, VIEWER, 1);

      const page = await get(code, '/offer-changes?page=1&pageSize=1&paging=pages', viewer);
      expect(page.status).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toMatchObject({
        page: 1,
        pageSize: 1,
        paging: 'pages',
        total: 2,
        totalPending: 2,
        hasNext: true,
        searchCapped: false,
      });
      const row = (page.body as { items: Record<string, unknown>[] }).items[0];
      expect(row).toMatchObject({
        changeId: a.change.state.id,
        proposedHandling: 'FRESH',
        storeName: 'Dates Co',
        product: { productCode: 'P00000001', name: 'Dates' },
        offer: { sellerSku: 'SKU-1', status: 'published', version: 5 },
        live: {
          description: { 'en-AU': 'Fresh dates' },
          handling: 'SEALED_ORIGINAL',
          tagTypes: [],
        },
        // The Viewer holds no approve key: no decision is offered.
        actions: [],
      });
      const filtered = await get(
        code,
        `/offer-changes?reasons=contact-text,review-all&sellerId=${SELLER}&submittedFrom=${encodeURIComponent(
          START.toString(),
        )}`,
        sessionOf(code, MODERATOR, 2),
      );
      expect((filtered.body as { items: { changeId: string; actions: string[] }[] }).items).toEqual(
        [
          expect.objectContaining({
            changeId: b.change.state.id,
            actions: ['approve', 'request-changes', 'reject'],
          }),
        ],
      );
      expect((await get(code, '/offer-changes?reasons=nope', viewer)).status).toBe(400);
      expect((await get(code, '/offer-changes?limit=1&page=1', viewer)).status).toBe(400);
      expect((await get(code, '/offer-changes?pageSize=abc', viewer)).status).toBe(400);
      expect((await get(code, '/offer-changes?q=x', viewer)).status).toBe(400);
    });

    it('exports the Edits list as CSV and XLSX, and reads one change with its live values', async () => {
      await boot();
      await seeded(code);
      const a = held(1, { proposedHandling: 'FRESH' });
      const viewer = sessionOf(code, VIEWER, 1);

      const csv = await get(code, '/offer-changes/export?reasons=handling', viewer).buffer(true);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toMatch(
        /^attachment; filename="offer-changes-.*\.csv"$/,
      );
      const lines = csv.text.replace('\uFEFF', '').trim().split(/\r?\n/);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(`${a.change.state.id},${a.offer.state.id},P00000001,Dates`);
      const xlsx = await get(code, '/offer-changes/export?format=xlsx', viewer).buffer(true);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      expect((await get(code, '/offer-changes/export?format=pdf', viewer)).status).toBe(400);
      expect((await get(code, '/offer-changes/export', null)).status).toBe(401);
      expect((await get(code, '/offer-changes/export', sessionOf(code, NO_KEY, 3))).status).toBe(
        403,
      );

      const one = await get(code, `/offer-changes/${a.change.state.id}`, viewer);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        changeId: a.change.state.id,
        live: { handling: 'SEALED_ORIGINAL' },
        proposedHandling: 'FRESH',
      });
      expect(
        (await get(code, `/offer-changes/${id<'OfferPendingChange'>(0x8fff)}`, viewer)).status,
      ).toBe(404);
      expect((await get(code, '/offer-changes/nope', viewer)).status).toBe(400);
      expect(
        (await get(code, `/offer-changes/${a.change.state.id}`, sessionOf(code, NO_KEY, 4))).status,
      ).toBe(403);
    });

    it('answers the stop banner counts, and 401 or 403 without a session or the key', async () => {
      await boot();
      await seeded(code);
      const stops = await get(code, '/offer-review/stops', sessionOf(code, VIEWER, 1));
      expect(stops.status).toBe(200);
      expect(stops.headers['cache-control']).toBe('no-store');
      expect(stops.body).toEqual({
        marketStop: true,
        stoppedSellers: 2,
        stoppedCategories: 1,
        active: true,
      });
      expect((await get(code, '/offer-review/stops', null)).status).toBe(401);
      expect((await get(code, '/offer-review/stops', sessionOf(code, NO_KEY, 3))).status).toBe(403);
    });

    it('bulk-approves R1 and R6 first publications and skips an R3 row with its name and blockers', async () => {
      await boot();
      await seeded(code);
      const r1 = waiting(code, 1);
      const r6 = waiting(code, 2);
      const r3 = waiting(code, 3);
      firstReasons.set(r1.state.id, ['probation']);
      firstReasons.set(r6.state.id, ['full-review']);
      firstReasons.set(r3.state.id, ['probation', 'handling']);

      const response = await post(
        code,
        '/review-queue/bulk-decide',
        sessionOf(code, MODERATOR, 1),
        {
          kind: 'offer',
          action: 'approve',
          items: [r1, r6, r3].map((offer) => ({ id: offer.state.id, version: 4 })),
        },
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        action: 'approve',
        counts: { done: 2, skipped: 1, failed: 0 },
        results: [
          { id: r1.state.id, outcome: 'done', name: 'Dates' },
          { id: r6.state.id, outcome: 'done', name: 'Dates' },
          {
            id: r3.state.id,
            outcome: 'skipped',
            reason: 'review.bulk-not-allowed',
            name: 'Dates',
            blockers: ['handling'],
          },
        ],
      });
      expect(offers.get(r3.state.id)!.state.status).toBe('pending-first-publish');
      expect(saved.map((s) => s.offer.state.id)).toEqual([r1.state.id, r6.state.id]);
    });

    it('approves a held change: its fields go live in one edit, admin actor, audited', async () => {
      await boot();
      await seeded(code);
      const { offer, change } = held(1, {
        proposedDescription: { 'en-AU': 'Fresher dates' },
        proposedHandling: 'FRESH',
      });

      const response = await post(
        code,
        `/offer-changes/${change.state.id}/approve`,
        sessionOf(code, MODERATOR, 1),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        changeId: change.state.id,
        offerId: offer.state.id,
        status: 'approved',
        fields: ['description', 'handling'],
      });
      expect(saved).toHaveLength(1);
      expect(saved[0]!.actor).toEqual({ kind: 'admin', accountId: MODERATOR });
      expect(saved[0]!.offer.state).toMatchObject({
        status: 'published',
        handling: 'FRESH',
        description: { 'en-AU': 'Fresher dates' },
      });
      expect(pendingChanges.rows.get(change.state.id)).toMatchObject({
        status: 'approved',
        decidedByAccountId: MODERATOR,
      });
      expect(audits.map((a) => a.action)).toContain('catalog.offer-change.approved');
      // An approved edit is not a first publication: no credit, no standing (Sajad G1).
      expect(standings.credits).toEqual([]);
      expect(standings.locks).toBe(0);

      const again = await post(
        code,
        `/offer-changes/${change.state.id}/approve`,
        sessionOf(code, MODERATOR, 2),
      );
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ statusCode: 409, code: 'offer-change.not-pending' });
    });

    it('answers 403 offer-change.own-submission to the admin who submitted the change', async () => {
      await boot();
      await seeded(code);
      const { change } = held(1, { proposedHandling: 'FRESH', submittedByAccountId: MODERATOR });
      const path = (route: string) => `/offer-changes/${change.state.id}/${route}`;
      const approve = await post(code, path('approve'), sessionOf(code, MODERATOR, 1));
      expect(approve.status).toBe(403);
      expect(approve.body).toEqual({ statusCode: 403, code: 'offer-change.own-submission' });
      const reject = await post(code, path('reject'), sessionOf(code, MODERATOR, 2), {
        note: 'No',
      });
      expect(reject.status).toBe(403);
      expect(saved).toHaveLength(0);
      expect(pendingChanges.rows.get(change.state.id)).toMatchObject({ status: 'pending' });
    });

    it('approves all or nothing: a refused requested tag stores nothing and leaves the change waiting', async () => {
      evaluator.decide = (q) => refusedDecision(q, 'no-certificate');
      evaluator.active = [typeCode];
      claimFacts.published = {
        productId: PRODUCT,
        productRevisionId: id<'ProductRevision'>(0xd001),
        revisionPublished: true,
        variantIds: [id<'Variant'>(0x6001)],
        platformCategoryPaths: [],
      };
      await boot();
      await seeded(code);
      const { change } = held(1, { proposedHandling: 'FRESH', proposedTagTypes: [typeCode] });

      const response = await post(
        code,
        `/offer-changes/${change.state.id}/approve`,
        sessionOf(code, MODERATOR, 1),
      );

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'claim.tag-not-allowed' });
      expect(saved).toHaveLength(0);
      expect(pendingChanges.rows.get(change.state.id)).toMatchObject({ status: 'pending' });
    });

    it('requests changes and rejects with a required note, and refuses a Viewer and a bad body', async () => {
      await boot();
      await seeded(code);
      const first = held(1, { proposedHandling: 'FRESH' });
      const second = held(2, { proposedHandling: 'REPACKED' });
      const moderator = () => sessionOf(code, MODERATOR, 1);
      const path = (changeId: string, route: string) => `/offer-changes/${changeId}/${route}`;

      const missing = await post(code, path(first.change.state.id, 'request-changes'), moderator());
      expect(missing.status).toBe(400);
      expect(missing.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'note' }] },
      });
      expect(
        (await post(code, path(first.change.state.id, 'reject'), moderator(), { note: '   ' }))
          .status,
      ).toBe(400);
      expect(
        (
          await post(code, path(first.change.state.id, 'reject'), moderator(), {
            note: 'x',
            extra: true,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(code, path(first.change.state.id, 'reject'), sessionOf(code, VIEWER, 2), {
            note: 'No',
          })
        ).status,
      ).toBe(403);
      expect((await post(code, path('nope', 'reject'), moderator(), { note: 'No' })).status).toBe(
        400,
      );
      const unknown = await post(
        code,
        path(id<'OfferPendingChange'>(0x8999), 'reject'),
        moderator(),
        { note: 'No' },
      );
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ statusCode: 404, code: 'offer-change.not-found' });

      const requested = await post(
        code,
        path(first.change.state.id, 'request-changes'),
        moderator(),
        { note: 'Please keep it sealed' },
      );
      expect(requested.status).toBe(200);
      expect(requested.body).toEqual({
        changeId: first.change.state.id,
        offerId: first.offer.state.id,
        status: 'changes-requested',
      });
      const rejected = await post(code, path(second.change.state.id, 'reject'), moderator(), {
        note: 'Not allowed',
      });
      expect(rejected.body).toMatchObject({ status: 'rejected' });
      expect(pendingChanges.rows.get(second.change.state.id)).toMatchObject({
        status: 'rejected',
        decisionNote: 'Not allowed',
      });
      // The live Offers keep their handling.
      expect(saved.map((s) => s.offer.state.handling)).toEqual([
        'SEALED_ORIGINAL',
        'SEALED_ORIGINAL',
      ]);
      expect(audits.map((a) => a.action).filter((action) => action.startsWith('catalog.'))).toEqual(
        ['catalog.offer-change.changes-requested', 'catalog.offer-change.rejected'],
      );
    });
  });
});
