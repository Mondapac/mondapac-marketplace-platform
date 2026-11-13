import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type {
  CallContext,
  ContentHash,
  Id,
  MarketContext,
  PendingEvent,
} from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CheckClaimText } from '../src/modules/catalog/application/claim-text/check-claim-text.service';
import { BRAND_ASSIGNER } from '../src/modules/catalog/application/ports/brand-assigner';
import { OFFER_REPOSITORY } from '../src/modules/catalog/application/ports/offer.repository';
import { OWN_OFFER_FINDER } from '../src/modules/catalog/application/ports/own-offer-finder';
import {
  OWN_CATALOG_READER,
  type PendingRevisionRow,
  type RevisionQueueFilter,
} from '../src/modules/catalog/application/ports/own-catalog.reader';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import {
  VARIANT_GTIN_REGISTRY,
  type GtinDuplicate,
} from '../src/modules/catalog/application/ports/variant-gtin.registry';
import {
  PRODUCT_REVISION_REPOSITORY,
  type ReviewDecision,
  type RevisionHistoryEntry,
} from '../src/modules/catalog/application/ports/product-revision.repository';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { SELLER_NAMES_READER } from '../src/modules/catalog/application/ports/seller-names.reader';
import { Offer } from '../src/modules/catalog/domain/offer';
import { Product, type ProductState } from '../src/modules/catalog/domain/product';
import type { StoredRevision } from '../src/modules/catalog/domain/stored-revision';
import { PRODUCT_REVIEW_STATUS } from '../src/modules/catalog/presentation/product-review.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { StaleAggregateError } from '../src/platform/unit-of-work/errors';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The review of seller product revisions over HTTP (catalog design 4.2, 8.2, 8.3a): the real
// guards, controllers, gate and use cases, with identity's ports and catalog's stores as in-memory
// fakes. Proved here: the admin session and CSRF token, the two keys (the seeded Moderator and
// Viewer roles), the closed bodies, the status of each refusal, the merged review queue (Offers and
// product revisions, store names, required checks, paging across both) and what a decision stores.

const START = Temporal.Instant.from('2026-10-16T10:00:00Z');
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
const PRODUCT = id<'Product'>(0xc101);
const REVISION = id<'ProductRevision'>(0xd101);
const VARIANT = id<'Variant'>(0xe101);
const ALL_CHECKS = [
  'photos-no-certification-mark',
  'category-fits',
  'tax-category-fits',
  'not-a-duplicate',
];

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the product review use cases to its exact status', () => {
  expect(PRODUCT_REVIEW_STATUS).toEqual({
    'validation.failed': 400,
    'product.not-found': 404,
    'revision.not-found': 404,
    'review.not-current-revision': 409,
    'review.checks-missing': 409,
    'revision.base-changed': 409,
    'product.not-editable': 409,
    'seller.not-eligible': 409,
    'conflict.stale': 409,
    'conflict.retry': 409,
    'variant.unknown': 409,
    'variant.none': 409,
    'variant.limit-reached': 422,
    'claim-text.refused': 422,
    'access.unavailable': 503,
    'claim.check-unavailable': 503,
  });
});

describe('admin product revision review over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let products: Map<string, ProductState>;
  let revisions: Map<string, StoredRevision>;
  let offers: Map<string, Offer>;
  let savedProducts: Product[];
  let decisions: ReviewDecision[];
  let events: PendingEvent[];
  let eligible: boolean;
  let claimVerdict: 'clean' | 'claim-text.found';
  let saveThrows: Error | null;
  let gtinMatches: GtinDuplicate[];
  let names: Map<Id<'Seller'>, string>;
  let offerFilters: { sellerId?: string }[];
  let history: RevisionHistoryEntry[];
  const http = () => request(app.getHttpServer());

  /** What the Prisma reader's `pendingRevisionsWhere` keeps, on the in-memory products. */
  const keptRevision = (p: ProductState, filter: RevisionQueueFilter) =>
    p.pendingRevisionId !== null &&
    (filter.sellerId === undefined || p.ownerSellerId === filter.sellerId) &&
    (filter.firstPublication === undefined ||
      (p.publishedRevisionId === null) === filter.firstPublication) &&
    (filter.hasImages === undefined ||
      revisions.get(p.pendingRevisionId)!.content.imageIds.length > 0 === filter.hasImages);

  const rowOf = (state: ProductState, revision: StoredRevision): PendingRevisionRow => ({
    productId: state.id,
    productVersion: state.version,
    sellerId: state.ownerSellerId!,
    productCode: state.productCode,
    typeCode: state.typeCode,
    revisionId: revision.id,
    revisionNo: revision.revisionNo,
    firstPublication: state.publishedRevisionId === null,
    sensitiveReasons: revision.sensitiveReasons,
    hasImages: revision.content.imageIds.length > 0,
    variantGtins: revision.content.variants.flatMap((v) => (v.gtin === null ? [] : [v.gtin])),
    name: 'Dates',
    submittedAt: state.pendingSubmittedAt!,
  });

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
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({
            lockAtVersion: (_m: MarketContext, productId: Id<'Product'>, version: number) =>
              Promise.resolve(products.get(productId)?.version === version),
            findById: (_m: MarketContext, productId: Id<'Product'>) =>
              Promise.resolve(
                products.has(productId) ? Product.restore(products.get(productId)!) : null,
              ),
            save: (_m: MarketContext, product: Product) => {
              if (saveThrows !== null) return Promise.reject(saveThrows);
              savedProducts.push(product);
              products.set(product.state.id, product.state);
              return Promise.resolve();
            },
          })
          .overrideProvider(PRODUCT_REVISION_REPOSITORY)
          .useValue({
            find: (_m: MarketContext, _p: Id<'Product'>, revisionId: Id<'ProductRevision'>) =>
              Promise.resolve(revisions.get(revisionId) ?? null),
            recordDecision: (_m: MarketContext, decision: ReviewDecision) => {
              decisions.push(decision);
              return Promise.resolve();
            },
            latestChangeRequest: () => Promise.resolve(null),
            history: () => Promise.resolve(history),
          })
          .overrideProvider(OFFER_REPOSITORY)
          .useValue({
            listPendingReview: (
              _m: MarketContext,
              page: { after: { submittedAt: Temporal.Instant; id: string } | null; limit: number },
              filter: { sellerId?: string } = {},
            ) => {
              offerFilters.push(filter);
              const waiting = [...offers.values()]
                .filter((o) => o.state.status === 'pending-first-publish')
                .filter(
                  (o) => filter.sellerId === undefined || o.state.sellerId === filter.sellerId,
                )
                .sort(
                  (a, b) =>
                    a.state.submittedAt!.epochMilliseconds - b.state.submittedAt!.epochMilliseconds,
                )
                .filter(
                  (o) =>
                    page.after === null ||
                    o.state.submittedAt!.epochMilliseconds >
                      page.after.submittedAt.epochMilliseconds,
                );
              return Promise.resolve(waiting.slice(0, page.limit));
            },
          })
          // The owner has no Offer on the product here: the approval asks nothing (the re-ask of
          // tags at publication is covered by the use-case and db specs, slice 11).
          .overrideProvider(BRAND_ASSIGNER)
          .useValue({ assignFromPublished: () => Promise.resolve() })
          .overrideProvider(OWN_OFFER_FINDER)
          .useValue({ findOwnOnProduct: () => Promise.resolve(null) })
          .overrideProvider(VARIANT_GTIN_REGISTRY)
          .useValue({
            duplicatesOf: (_m: MarketContext, _p: Id<'Product'>, gtins: readonly string[]) =>
              Promise.resolve(gtinMatches.filter((match) => gtins.includes(match.gtin))),
          })
          .overrideProvider(OWN_CATALOG_READER)
          .useValue({
            pendingReviewCount: (_m: MarketContext, filter: { sellerId?: string } = {}) =>
              Promise.resolve(
                [...offers.values()].filter(
                  (o) =>
                    o.state.status === 'pending-first-publish' &&
                    (filter.sellerId === undefined || o.state.sellerId === filter.sellerId),
                ).length,
              ),
            pendingRevisionCount: (_m: MarketContext, filter: RevisionQueueFilter = {}) =>
              Promise.resolve([...products.values()].filter((p) => keptRevision(p, filter)).length),
            listPendingRevisions: (
              _m: MarketContext,
              page: { after: { submittedAt: Temporal.Instant; id: string } | null; limit: number },
              _locale: string,
              filter: RevisionQueueFilter = {},
            ) =>
              Promise.resolve(
                [...products.values()]
                  .filter((p) => keptRevision(p, filter))
                  .sort(
                    (a, b) =>
                      a.pendingSubmittedAt!.epochMilliseconds -
                      b.pendingSubmittedAt!.epochMilliseconds,
                  )
                  .filter(
                    (p) =>
                      page.after === null ||
                      p.pendingSubmittedAt!.epochMilliseconds >
                        page.after.submittedAt.epochMilliseconds,
                  )
                  .slice(0, page.limit)
                  .map((p) => rowOf(p, revisions.get(p.pendingRevisionId!)!)),
              ),
            productLabels: () =>
              Promise.resolve([
                {
                  productId: id(0xc001),
                  productCode: 'P00000009',
                  typeCode: 'simple',
                  name: 'Figs',
                },
              ]),
          })
          .overrideProvider(SELLER_NAMES_READER)
          .useValue({ storeNames: () => Promise.resolve(names) })
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(eligible) })
          .overrideProvider(CheckClaimText)
          .useValue({
            execute: (_c: CallContext, texts: readonly { locale: string; field: string }[]) =>
              Promise.resolve({
                ok: true,
                value: texts.map((t) =>
                  claimVerdict === 'clean'
                    ? { code: 'clean', field: t.field, ref: null, locale: t.locale }
                    : {
                        code: 'claim-text.found',
                        field: t.field,
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

  /** A SELLER product with a pending revision; `n` orders the queue. */
  function pendingProduct(
    code: string,
    n: number,
    overrides: Partial<ProductState> = {},
    gtin: string | null = null,
  ) {
    const productId = n === 1 ? PRODUCT : id<'Product'>(0xc100 + n);
    const revisionId = n === 1 ? REVISION : id<'ProductRevision'>(0xd100 + n);
    const variantId = n === 1 ? VARIANT : id<'Variant'>(0xe100 + n);
    const defaultLocale = code === 'AU' ? 'en-AU' : 'ja-JP';
    const state: ProductState = {
      id: productId,
      marketId: code as AccountState['marketId'],
      scope: 'SELLER',
      ownerSellerId: SELLER,
      createdBySellerId: SELLER,
      typeCode: 'simple',
      variantModel: 'single',
      familyCode: 'default',
      productCode: `P0000010${n}`,
      status: 'unpublished',
      discardedAt: null,
      withdrawnAt: null,
      retiredAt: null,
      pausedAt: null,
      pausedByAccountId: null,
      ownBrand: false,
      lastChangedAt: START,
      version: 4,
      createdAt: START,
      variants: [
        {
          id: variantId,
          variantNo: 1,
          state: 'proposed',
          createdAt: START,
          publishedAt: null,
          retiredAt: null,
        },
      ],
      publishedRevisionId: null,
      pendingRevisionId: revisionId,
      pendingSubmittedAt: START.add({ minutes: n }),
      ...overrides,
    };
    revisions.set(revisionId, {
      id: revisionId,
      productId,
      revisionNo: 1,
      typeCode: 'simple',
      kind: 'submission',
      baseRevisionId: null,
      revertedFromRevisionId: null,
      sensitive: true,
      sensitiveReasons: ['never-published', 'approval-required'],
      contentHash: 'sha256:abcd' as ContentHash,
      authorKind: 'seller',
      authorAccountId: id<'Account'>(0xa900),
      actingAdminAccountId: null,
      submittedAt: START,
      content: {
        texts: { [defaultLocale]: { name: 'Dates', shortDescription: null, description: null } },
        categoryIds: [],
        topicIds: [],
        taxCategoryCode: 'gst',
        attributeValues: {},
        variants: [
          {
            variantId,
            position: 1,
            optionKey: '',
            optionValues: {},
            labels: {},
            gtin,
            shippingWeightGrams: null,
            shippingLengthMm: null,
            shippingWidthMm: null,
            shippingHeightMm: null,
            imageIds: [],
          },
        ],
        imageIds: [],
        schemaRef: { familyRevisionId: 'f', definitionRevisionIds: [] },
        contentSchemaVersion: 1,
      },
    });
    products.set(productId, state);
    return { productId, revisionId };
  }

  function waitingOffer(code: string, n: number) {
    const offer = Offer.restore({
      id: id<'Offer'>(0x9000 + n),
      marketId: code as AccountState['marketId'],
      sellerId: SELLER,
      productId: id(0xc001),
      sellerSku: `SKU-${n}`,
      conditionCode: 'new',
      description: {},
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
        id: id<'RoleAssignment'>(0xe900 + n),
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
        id: id<'Session'>(0xf200 + n),
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
  const approvePath = (productId = PRODUCT, revisionId = REVISION) =>
    `/products/${productId}/revisions/${revisionId}/approve`;
  const changesPath = (productId = PRODUCT, revisionId = REVISION) =>
    `/products/${productId}/revisions/${revisionId}/request-changes`;

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    products = new Map();
    revisions = new Map();
    offers = new Map();
    savedProducts = [];
    decisions = [];
    events = [];
    eligible = true;
    claimVerdict = 'clean';
    saveThrows = null;
    gtinMatches = [];
    names = new Map([[SELLER, 'Dates Co']]);
    offerFilters = [];
    history = [];
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the three routes and their error codes in OpenAPI', async () => {
    await boot();
    await app.close();
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const read =
      document.paths['/catalog/admin/products/{productId}/revisions/{revisionId}']?.get?.responses;
    for (const status of ['200', '400', '401', '403', '404', '503']) {
      expect(read).toHaveProperty(status);
    }
    for (const route of ['approve', 'request-changes']) {
      const responses =
        document.paths[`/catalog/admin/products/{productId}/revisions/{revisionId}/${route}`]?.post
          ?.responses;
      for (const status of ['200', '400', '403', '404', '409', '503']) {
        expect(responses).toHaveProperty(status);
      }
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('warns the reviewer when a GTIN of a pending revision is carried by another product', async () => {
      await boot();
      await seeded(code);
      const plain = pendingProduct(code, 3);
      const platform = pendingProduct(code, 1, {}, '04006381333931');
      const neutral = pendingProduct(code, 2, {}, '04012345678905');
      gtinMatches = [
        { gtin: '04006381333931', scope: 'PLATFORM', platformProductCode: 'MP-004127' },
        { gtin: '04012345678905', scope: 'SELLER', platformProductCode: null },
      ];

      const response = await get(code, '/review-queue', sessionOf(code, VIEWER, 1));

      const items = (response.body as { items: { productId: string; warnings: string[] }[] }).items;
      const warningsOf = (productId: string) =>
        items.find((item) => item.productId === productId)?.warnings;
      expect(warningsOf(platform.productId)).toEqual(['gtin.duplicate-platform']);
      expect(warningsOf(neutral.productId)).toEqual(['gtin.duplicate']);
      expect(warningsOf(plain.productId)).toEqual([]);
      // The reviewer is told there is a duplicate, never which seller's product it is.
      expect(JSON.stringify(response.body)).not.toContain('MP-004127');
    });

    it('lists product revisions with the Offers in one queue, oldest first, with store name and checks', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 3);
      pendingProduct(code, 1);
      const offer = waitingOffer(code, 2);

      const response = await get(code, '/review-queue', sessionOf(code, VIEWER, 1));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as {
        items: Record<string, unknown>[];
        nextAfterId: unknown;
        total: number;
      };
      expect(body.items.map((i) => i.kind)).toEqual([
        'product-revision',
        'offer-first-publication',
        'product-revision',
      ]);
      expect(body.items[1]).toMatchObject({ offerId: offer.state.id, storeName: 'Dates Co' });
      expect(body.items[0]).toEqual({
        kind: 'product-revision',
        productId: PRODUCT,
        revisionId: REVISION,
        revisionNo: 1,
        version: 4,
        sellerId: SELLER,
        storeName: 'Dates Co',
        product: { productCode: 'P00000101', typeCode: 'simple', name: 'Dates' },
        firstPublication: true,
        reasons: ['never-published', 'approval-required'],
        requiredChecks: ALL_CHECKS,
        hasImages: false,
        warnings: [],
        submittedAt: START.add({ minutes: 1 }).toString(),
      });
      expect(body.nextAfterId).toBeNull();
      expect(body.total).toBe(3);
    });

    it('pages across both kinds with the opaque cursor and refuses a bad one', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 1);
      waitingOffer(code, 2);
      pendingProduct(code, 3);
      const session = sessionOf(code, VIEWER, 1);

      const first = await get(code, '/review-queue?limit=2', session);
      const firstBody = first.body as { items: { kind: string }[]; nextAfterId: string };
      expect(firstBody.items.map((i) => i.kind)).toEqual([
        'product-revision',
        'offer-first-publication',
      ]);
      expect(firstBody.nextAfterId).toEqual(expect.any(String));
      const second = await get(
        code,
        `/review-queue?limit=2&afterId=${firstBody.nextAfterId}`,
        session,
      );
      const secondBody = second.body as { items: { kind: string }[]; nextAfterId: unknown };
      expect(secondBody.items.map((i) => i.kind)).toEqual(['product-revision']);
      expect(secondBody.nextAfterId).toBeNull();
      expect((await get(code, '/review-queue?afterId=nope', session)).status).toBe(400);
      expect((await get(code, `/review-queue?afterId=${PRODUCT}`, session)).status).toBe(400);
    });

    it('shows a row without a store name when sellers cannot say', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 1);
      names = new Map();

      const response = await get(code, '/review-queue', sessionOf(code, VIEWER, 1));

      expect(response.status).toBe(200);
      expect((response.body as { items: { storeName: unknown }[] }).items[0]!.storeName).toBeNull();
    });

    it('filters the queue by kind, seller, first publication and photos, with a total per kind', async () => {
      await boot();
      await seeded(code);
      const OTHER = id<'Seller'>(0xb021);
      const first = pendingProduct(code, 1);
      const update = pendingProduct(code, 2, {
        status: 'published',
        publishedRevisionId: id<'ProductRevision'>(0xd1f2),
      });
      const others = pendingProduct(code, 3, { ownerSellerId: OTHER, createdBySellerId: OTHER });
      const withPhoto = revisions.get(update.revisionId)!;
      revisions.set(update.revisionId, {
        ...withPhoto,
        content: { ...withPhoto.content, imageIds: [id(0x7001)] },
      });
      waitingOffer(code, 4);
      const session = sessionOf(code, VIEWER, 1);
      type Body = {
        items: { kind: string; productId: string }[];
        total: number;
        totals: Record<string, number>;
      };
      const list = async (query: string) => {
        const response = await get(code, `/review-queue?${query}`, session);
        expect(response.status).toBe(200);
        return response.body as Body;
      };
      const wholeQueue = { 'product-revision': 3, 'offer-first-publication': 1 };

      const all = await list('');
      expect(all.total).toBe(4);
      expect(all.totals).toEqual(wholeQueue);

      const revisionsOnly = await list('kind=product-revision');
      expect(revisionsOnly.items.map((i) => i.kind)).toEqual([
        'product-revision',
        'product-revision',
        'product-revision',
      ]);
      expect(revisionsOnly.total).toBe(3);
      expect(revisionsOnly.totals).toEqual(wholeQueue);

      const offersOnly = await list('kind=offer-first-publication');
      expect(offersOnly.items.map((i) => i.kind)).toEqual(['offer-first-publication']);
      expect(offersOnly.total).toBe(1);

      const ofSeller = await list(`sellerId=${OTHER}`);
      expect(ofSeller.items.map((i) => i.productId)).toEqual([others.productId]);
      expect(ofSeller.total).toBe(1);
      expect(offerFilters.at(-1)).toEqual({ sellerId: OTHER });

      const firstOnly = await list('firstPublication=true');
      expect(firstOnly.items.map((i) => i.productId)).toEqual([first.productId, others.productId]);
      expect(firstOnly.total).toBe(2);
      const updates = await list('firstPublication=false');
      expect(updates.items.map((i) => i.productId)).toEqual([update.productId]);
      expect(updates.total).toBe(1);

      const photos = await list('hasImages=true');
      expect(photos.items.map((i) => i.productId)).toEqual([update.productId]);
      expect(photos.total).toBe(1);
      expect(photos.totals).toEqual(wholeQueue);
      const noPhotos = await list('hasImages=false&sellerId=' + SELLER);
      expect(noPhotos.items.map((i) => i.productId)).toEqual([first.productId]);
      expect(noPhotos.total).toBe(1);
    });

    it('keeps the filters on the next page of the cursor', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 1);
      waitingOffer(code, 2);
      pendingProduct(code, 3);
      pendingProduct(code, 5);
      const session = sessionOf(code, VIEWER, 1);

      const page1 = (await get(code, '/review-queue?kind=product-revision&limit=2', session))
        .body as { items: { kind: string }[]; nextAfterId: string };
      expect(page1.items).toHaveLength(2);
      const page2 = (
        await get(
          code,
          `/review-queue?kind=product-revision&limit=2&afterId=${page1.nextAfterId}`,
          session,
        )
      ).body as { items: { kind: string }[]; nextAfterId: unknown };
      expect(page2.items.map((i) => i.kind)).toEqual(['product-revision']);
      expect(page2.nextAfterId).toBeNull();
    });

    it('refuses a bad filter value, and a revision filter on the Offers', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);
      const refused = async (query: string, path: string, fieldCode: string) => {
        const response = await get(code, `/review-queue?${query}`, session);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path, code: fieldCode }] },
        });
      };
      await refused('kind=offers', 'kind', 'unknown');
      await refused('sellerId=nope', 'sellerId', 'format');
      await refused('firstPublication=yes', 'firstPublication', 'type');
      await refused('hasImages=1', 'hasImages', 'type');
      await refused('kind=offer-first-publication&hasImages=true', 'hasImages', 'not-allowed');
      await refused('status=pending', 'status', 'unknown');
    });

    it('reads a pending first publication for review: content, checks, no published one, history', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 1, {}, '04006381333931');
      gtinMatches = [{ gtin: '04006381333931', scope: 'SELLER', platformProductCode: null }];
      history = [
        {
          revisionId: REVISION,
          revisionNo: 1,
          kind: 'submission',
          authorKind: 'seller',
          submittedAt: START,
          decision: null,
        },
      ];

      const response = await get(
        code,
        `/products/${PRODUCT}/revisions/${REVISION}`,
        sessionOf(code, VIEWER, 1),
      );

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const defaultLocale = code === 'AU' ? 'en-AU' : 'ja-JP';
      expect(response.body).toEqual({
        productId: PRODUCT,
        productCode: 'P00000101',
        typeCode: 'simple',
        status: 'unpublished',
        version: 4,
        sellerId: SELLER,
        storeName: 'Dates Co',
        state: 'pending',
        firstPublication: true,
        reasons: ['never-published', 'approval-required'],
        requiredChecks: ALL_CHECKS,
        warnings: ['gtin.duplicate'],
        revision: {
          revisionId: REVISION,
          revisionNo: 1,
          kind: 'submission',
          authorKind: 'seller',
          submittedAt: START.toString(),
          texts: { [defaultLocale]: { name: 'Dates', shortDescription: null, description: null } },
          categoryIds: [],
          topicIds: [],
          taxCategoryCode: 'gst',
          attributeValues: {},
          variants: [
            {
              variantId: VARIANT,
              position: 1,
              optionValues: {},
              labels: {},
              gtin: '04006381333931',
              shippingWeightGrams: null,
              shippingLengthMm: null,
              shippingWidthMm: null,
              shippingHeightMm: null,
              imageIds: [],
            },
          ],
          imageIds: [],
        },
        topicRefs: [],
        topicDiff: { added: [], removed: [] },
        published: null,
        history: [
          {
            revisionId: REVISION,
            revisionNo: 1,
            kind: 'submission',
            authorKind: 'seller',
            submittedAt: START.toString(),
            decision: null,
          },
        ],
      });
      // Who wrote it stays out of the answer.
      expect(JSON.stringify(response.body)).not.toContain(id<'Account'>(0xa900));
    });

    it('reads an update next to the published revision, and a closed one without checks', async () => {
      await boot();
      await seeded(code);
      const PUBLISHED = id<'ProductRevision'>(0xd1f1);
      pendingProduct(code, 1, { status: 'published', publishedRevisionId: PUBLISHED });
      const pending = revisions.get(REVISION)!;
      const defaultLocale = code === 'AU' ? 'en-AU' : 'ja-JP';
      revisions.set(PUBLISHED, {
        ...pending,
        id: PUBLISHED,
        revisionNo: 1,
        sensitiveReasons: [],
        content: {
          ...pending.content,
          texts: {
            [defaultLocale]: { name: 'Old dates', shortDescription: null, description: null },
          },
          taxCategoryCode: 'gst-free',
        },
      });
      revisions.set(REVISION, {
        ...pending,
        revisionNo: 2,
        sensitiveReasons: ['tax-category'],
      });
      history = [
        {
          revisionId: REVISION,
          revisionNo: 2,
          kind: 'submission',
          authorKind: 'seller',
          submittedAt: START.add({ minutes: 1 }),
          decision: null,
        },
        {
          revisionId: PUBLISHED,
          revisionNo: 1,
          kind: 'submission',
          authorKind: 'seller',
          submittedAt: START,
          decision: {
            outcome: 'published',
            publishKind: 'reviewed',
            supersededCause: null,
            reasonCode: null,
            decidedByKind: 'admin',
            decidedAt: START,
          },
        },
      ];
      const session = sessionOf(code, VIEWER, 1);

      const pendingRead = await get(code, `/products/${PRODUCT}/revisions/${REVISION}`, session);
      expect(pendingRead.status).toBe(200);
      expect(pendingRead.body).toMatchObject({
        state: 'pending',
        firstPublication: false,
        requiredChecks: ['tax-category-fits'],
        revision: { revisionId: REVISION, taxCategoryCode: 'gst' },
        published: {
          revisionId: PUBLISHED,
          taxCategoryCode: 'gst-free',
          texts: { [defaultLocale]: { name: 'Old dates' } },
        },
      });
      expect((pendingRead.body as { history: unknown[] }).history[1]).toEqual({
        revisionId: PUBLISHED,
        revisionNo: 1,
        kind: 'submission',
        authorKind: 'seller',
        submittedAt: START.toString(),
        decision: {
          outcome: 'published',
          publishKind: 'reviewed',
          supersededCause: null,
          reasonCode: null,
          decidedByKind: 'admin',
          decidedAt: START.toString(),
        },
      });

      const publishedRead = await get(code, `/products/${PRODUCT}/revisions/${PUBLISHED}`, session);
      expect(publishedRead.body).toMatchObject({
        state: 'published',
        requiredChecks: [],
        warnings: [],
        revision: { revisionId: PUBLISHED },
        published: { revisionId: PUBLISHED },
      });

      products.set(PRODUCT, { ...products.get(PRODUCT)!, pendingRevisionId: null });
      const closedRead = await get(code, `/products/${PRODUCT}/revisions/${REVISION}`, session);
      expect(closedRead.body).toMatchObject({ state: 'closed', requiredChecks: [] });
    });

    it('refuses the revision read without the view key, for a PLATFORM or unknown product and a bad id', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 1);
      const platform = pendingProduct(code, 2, { scope: 'PLATFORM', ownerSellerId: null });
      const read = (path: string, account = VIEWER) =>
        get(code, path, sessionOf(code, account, account === VIEWER ? 1 : 2));

      expect((await read(`/products/${PRODUCT}/revisions/${REVISION}`, NO_KEY)).status).toBe(403);
      expect((await get(code, `/products/${PRODUCT}/revisions/${REVISION}`, null)).status).toBe(
        401,
      );
      const platformRead = await read(
        `/products/${platform.productId}/revisions/${platform.revisionId}`,
      );
      expect(platformRead.status).toBe(404);
      expect(platformRead.body).toMatchObject({ code: 'product.not-found' });
      const unknown = await read(`/products/${id(0xc1ff)}/revisions/${REVISION}`);
      expect(unknown.body).toMatchObject({ code: 'product.not-found' });
      const otherRevision = await read(`/products/${PRODUCT}/revisions/${id(0xd1ff)}`);
      expect(otherRevision.status).toBe(404);
      expect(otherRevision.body).toMatchObject({ code: 'revision.not-found' });
      expect((await read(`/products/nope/revisions/${REVISION}`)).status).toBe(400);
    });

    it.each(['photos', 'category', 'tax-category', 'duplicate'])(
      'sends the revision back with the product reason %s',
      async (reasonCode) => {
        await boot();
        await seeded(code);
        pendingProduct(code, 1);

        const response = await post(code, changesPath(), sessionOf(code, MODERATOR, 1), {
          version: 4,
          reasonCode,
        });

        expect(response.status).toBe(200);
        expect(decisions).toEqual([expect.objectContaining({ reasonCode })]);
        expect(events[0]).toMatchObject({
          type: 'catalog.product-revision-changes-requested.v2',
          payload: { reasonCode },
        });
      },
    );

    it('approves with the approve key: published pointer, decision row, event, no other change', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 1);

      const response = await post(code, approvePath(), sessionOf(code, MODERATOR, 1), {
        version: 4,
        checksConfirmed: ALL_CHECKS,
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
      expect(savedProducts).toHaveLength(1);
      expect(savedProducts[0]!.state).toMatchObject({
        status: 'published',
        publishedRevisionId: REVISION,
        pendingRevisionId: null,
        ownerSellerId: SELLER,
        version: 5,
      });
      expect(savedProducts[0]!.state.variants[0]).toMatchObject({ state: 'published' });
      expect(decisions).toEqual([
        expect.objectContaining({
          revisionId: REVISION,
          outcome: 'published',
          decidedByAccountId: MODERATOR,
          requiredChecks: ALL_CHECKS,
          confirmedChecks: ALL_CHECKS,
          productVersion: 4,
        }),
      ]);
      expect(events.map((e) => e.type)).toEqual(['catalog.product-revision-published.v1']);
    });

    it('refuses a decision from a Viewer or a holder of no key, storing nothing', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 1);

      for (const [account, n] of [
        [VIEWER, 1],
        [NO_KEY, 2],
      ] as const) {
        const session = sessionOf(code, account, n);
        expect(
          (await post(code, approvePath(), session, { version: 4, checksConfirmed: ALL_CHECKS }))
            .status,
        ).toBe(403);
        expect(
          (await post(code, changesPath(), session, { version: 4, reasonCode: 'other' })).status,
        ).toBe(403);
      }
      expect(savedProducts).toHaveLength(0);
      expect(decisions).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it('answers 404, 409 and 422 with the refusal code and stores nothing', async () => {
      await boot();
      await seeded(code);
      const session = () => sessionOf(code, MODERATOR, 1);
      pendingProduct(code, 1);
      const approve = (body: Record<string, unknown>, productId = PRODUCT, revisionId = REVISION) =>
        post(code, approvePath(productId, revisionId), session(), {
          version: 4,
          checksConfirmed: ALL_CHECKS,
          ...body,
        });

      const unknown = await approve({}, id<'Product'>(0x7777));
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ statusCode: 404, code: 'product.not-found' });
      expect((await approve({ version: 3 })).body).toMatchObject({ code: 'conflict.stale' });
      expect((await approve({}, PRODUCT, id<'ProductRevision'>(0x7778))).body).toMatchObject({
        code: 'review.not-current-revision',
      });
      const missing = await approve({ checksConfirmed: ['category-fits'] });
      expect(missing.status).toBe(409);
      expect(missing.body).toMatchObject({
        code: 'review.checks-missing',
        details: {
          issues: [
            { path: 'checksConfirmed', code: 'photos-no-certification-mark' },
            { path: 'checksConfirmed', code: 'tax-category-fits' },
            { path: 'checksConfirmed', code: 'not-a-duplicate' },
          ],
        },
      });
      eligible = false;
      expect((await approve({})).body).toMatchObject({ code: 'seller.not-eligible' });
      eligible = true;
      claimVerdict = 'claim-text.found';
      const refused = await approve({});
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ code: 'claim-text.refused' });
      expect(savedProducts).toHaveLength(0);
      expect(decisions).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it('answers 409 revision.base-changed when the published revision moved after the submit', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 1, {
        status: 'published',
        publishedRevisionId: id<'ProductRevision'>(0xd999),
      });

      const response = await post(code, approvePath(), sessionOf(code, MODERATOR, 1), {
        version: 4,
        checksConfirmed: ALL_CHECKS,
      });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'revision.base-changed' });
      expect(savedProducts).toHaveLength(0);
    });

    it('answers a lost race on the save as 409 conflict.stale, storing and announcing nothing', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 1);
      saveThrows = new StaleAggregateError('product', PRODUCT);

      const approve = await post(code, approvePath(), sessionOf(code, MODERATOR, 1), {
        version: 4,
        checksConfirmed: ALL_CHECKS,
      });
      const changes = await post(code, changesPath(), sessionOf(code, MODERATOR, 2), {
        version: 4,
        reasonCode: 'other',
      });

      for (const response of [approve, changes]) {
        expect(response.status).toBe(409);
        expect(response.body).toEqual({ statusCode: 409, code: 'conflict.stale' });
      }
      expect(decisions).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it('sends the revision back with a reason code: pointer cleared, decision and event carry the code', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 1);

      const response = await post(code, changesPath(), sessionOf(code, MODERATOR, 1), {
        version: 4,
        reasonCode: 'description-claim',
      });

      expect(response.status).toBe(200);
      expect(savedProducts[0]!.state).toMatchObject({
        status: 'unpublished',
        publishedRevisionId: null,
        pendingRevisionId: null,
      });
      expect(decisions).toEqual([
        expect.objectContaining({
          revisionId: REVISION,
          outcome: 'changes-requested',
          reasonCode: 'description-claim',
          decidedByAccountId: MODERATOR,
        }),
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'catalog.product-revision-changes-requested.v2',
        payload: {
          productId: PRODUCT,
          revisionId: REVISION,
          reasonCode: 'description-claim',
          scope: 'seller',
        },
      });
    });

    it('refuses a bad reason, an unknown field, a missing field and a bad id, storing nothing', async () => {
      await boot();
      await seeded(code);
      const session = () => sessionOf(code, MODERATOR, 1);
      pendingProduct(code, 1);

      const reason = await post(code, changesPath(), session(), {
        version: 4,
        reasonCode: 'free text',
      });
      expect(reason.status).toBe(400);
      expect(reason.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'reasonCode', code: 'unknown' }] },
      });
      expect((await post(code, changesPath(), session(), { version: 4 })).status).toBe(400);
      expect(
        (
          await post(code, changesPath(), session(), {
            version: 4,
            reasonCode: 'other',
            note: 'x',
          })
        ).status,
      ).toBe(400);
      expect(
        (await post(code, approvePath(), session(), { version: 4, checksConfirmed: ['made-up'] }))
          .status,
      ).toBe(400);
      expect((await post(code, approvePath(), session(), { version: 4 })).status).toBe(400);
      expect(
        (
          await post(code, approvePath(), session(), {
            version: '4',
            checksConfirmed: ALL_CHECKS,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(code, `/products/nope/revisions/${REVISION}/approve`, session(), {
            version: 4,
            checksConfirmed: ALL_CHECKS,
          })
        ).status,
      ).toBe(400);
      expect(savedProducts).toHaveLength(0);
      expect(decisions).toHaveLength(0);
    });

    it('refuses a decision without the CSRF token, without a session and from the seller origin', async () => {
      await boot();
      await seeded(code);
      pendingProduct(code, 1);
      const session = sessionOf(code, MODERATOR, 1);
      const path = `/catalog/admin${approvePath()}`;
      const body = { version: 4, checksConfirmed: ALL_CHECKS };

      const noCsrf = await http()
        .post(path)
        .set({ ...base(code), cookie: session.cookie })
        .send(body);
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect((await http().post(path).set(base(code)).send(body)).status).toBe(401);
      const sellerOrigin = await http()
        .post(path)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...session })
        .send(body);
      expect(sellerOrigin.status).toBe(403);
      expect(savedProducts).toHaveLength(0);
    });
  });
});
