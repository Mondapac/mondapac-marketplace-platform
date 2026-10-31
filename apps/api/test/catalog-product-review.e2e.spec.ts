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
} from '../src/modules/catalog/application/ports/own-catalog.reader';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import {
  PRODUCT_REVISION_REPOSITORY,
  type ReviewDecision,
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
  let names: Map<Id<'Seller'>, string>;
  const http = () => request(app.getHttpServer());

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
          })
          .overrideProvider(OFFER_REPOSITORY)
          .useValue({
            listPendingReview: (
              _m: MarketContext,
              page: { after: { submittedAt: Temporal.Instant; id: string } | null; limit: number },
            ) => {
              const waiting = [...offers.values()]
                .filter((o) => o.state.status === 'pending-first-publish')
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
          .overrideProvider(OWN_CATALOG_READER)
          .useValue({
            pendingReviewCount: () =>
              Promise.resolve(
                [...offers.values()].filter((o) => o.state.status === 'pending-first-publish')
                  .length,
              ),
            pendingRevisionCount: () =>
              Promise.resolve(
                [...products.values()].filter((p) => p.pendingRevisionId !== null).length,
              ),
            listPendingRevisions: (
              _m: MarketContext,
              page: { after: { submittedAt: Temporal.Instant; id: string } | null; limit: number },
            ) =>
              Promise.resolve(
                [...products.values()]
                  .filter((p) => p.pendingRevisionId !== null)
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
  function pendingProduct(code: string, n: number, overrides: Partial<ProductState> = {}) {
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
      ownBrand: false,
      lastChangedAt: START,
      version: 4,
      createdAt: START,
      variants: [
        { id: variantId, state: 'proposed', createdAt: START, publishedAt: null, retiredAt: null },
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
        taxCategoryCode: 'gst',
        attributeValues: {},
        variants: [{ variantId, position: 1, optionKey: '', optionValues: {}, labels: {} }],
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
    names = new Map([[SELLER, 'Dates Co']]);
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the two routes and their error codes in OpenAPI', async () => {
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
        type: 'catalog.product-revision-changes-requested.v1',
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
