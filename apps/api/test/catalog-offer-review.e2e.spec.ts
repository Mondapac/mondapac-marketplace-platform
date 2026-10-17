import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, PendingEvent } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CheckClaimText } from '../src/modules/catalog/application/claim-text/check-claim-text.service';
import { ALLOWED_PRODUCT_TYPES_READER } from '../src/modules/catalog/application/ports/allowed-product-types.reader';
import { OFFER_REPOSITORY } from '../src/modules/catalog/application/ports/offer.repository';
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
    'claim-text.refused': 422,
    'access.unavailable': 503,
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
  });

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
      });
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
});
