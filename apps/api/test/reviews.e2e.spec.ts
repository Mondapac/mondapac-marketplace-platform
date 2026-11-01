import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { DeleteProductReview } from '../src/modules/reviews/application/use-cases/delete-product-review.use-case';
import { EditProductReview } from '../src/modules/reviews/application/use-cases/edit-product-review.use-case';
import { ListMyReviews } from '../src/modules/reviews/application/use-cases/list-my-reviews.use-case';
import { ListProductReviews } from '../src/modules/reviews/application/use-cases/list-product-reviews.use-case';
import { ListToReview } from '../src/modules/reviews/application/use-cases/list-to-review.use-case';
import { ListModerationQueue } from '../src/modules/reviews/application/use-cases/list-moderation-queue.use-case';
import { ModerateReview } from '../src/modules/reviews/application/use-cases/moderate-review.use-case';
import { RemoveReview } from '../src/modules/reviews/application/use-cases/remove-review.use-case';
import { ViewModerationReview } from '../src/modules/reviews/application/use-cases/view-moderation-review.use-case';
import { RateSellerOrder } from '../src/modules/reviews/application/use-cases/rate-seller-order.use-case';
import { SetReviewsStatus } from '../src/modules/reviews/application/use-cases/set-reviews-status.use-case';
import { SubmitProductReview } from '../src/modules/reviews/application/use-cases/submit-product-review.use-case';
import { ViewProductSummary } from '../src/modules/reviews/application/use-cases/view-product-summary.use-case';
import { ViewReviewsSettings } from '../src/modules/reviews/application/use-cases/view-reviews-settings.use-case';
import { ViewSellerSummary } from '../src/modules/reviews/application/use-cases/view-seller-summary.use-case';
import { REVIEWS_STATUS } from '../src/modules/reviews/presentation/http-answers';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The reviews routes over HTTP: the real guards and controllers; the use cases are stubs, so this
// proves the session, the population of each route, CSRF, the closed body and query, the status
// of each refusal, the answer shape and `no-store`. The use cases have their own spec.

const START = Temporal.Instant.from('2026-10-25T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xa101);
const ADMIN = id<'Account'>(0xa001);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps every refusal code of the reviews routes to its exact status', () => {
  expect(REVIEWS_STATUS).toEqual({
    'validation.failed': 400,
    'reviews.not-eligible': 403,
    'reviews.own-store': 403,
    'reviews.own-review': 403,
    'reviews.disabled': 404,
    'reviews.not-found': 404,
    'reviews.window-closed': 409,
    'reviews.already-reviewed': 409,
    'reviews.already-rated': 409,
    'reviews.not-editable': 409,
    'reviews.edit-window-closed': 409,
    'reviews.not-moderatable': 409,
    'reviews.rate-limited': 429,
    'reviews.unavailable': 503,
    'second-factor.required': 403,
    'second-factor.enrolment-required': 403,
  });
});

describe.each(TEST_MARKETS)('reviews over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const stub = (name: string) => ({
    execute: (_c: unknown, input: unknown) => {
      calls.push({ name, input });
      return Promise.resolve(next);
    },
  });
  const REVIEW = id<'ProductReview'>(0xe001);
  const PRODUCT = id<'Product'>(0xe002);
  const SELLER_ORDER = id<'SellerOrder'>(0xe003);

  async function boot() {
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        [
          ['list-to-review', ListToReview],
          ['list-my-reviews', ListMyReviews],
          ['submit', SubmitProductReview],
          ['edit', EditProductReview],
          ['delete', DeleteProductReview],
          ['rate', RateSellerOrder],
          ['list-product-reviews', ListProductReviews],
          ['product-summary', ViewProductSummary],
          ['seller-summary', ViewSellerSummary],
          ['view-settings', ViewReviewsSettings],
          ['set-status', SetReviewsStatus],
          ['queue', ListModerationQueue],
          ['view-review', ViewModerationReview],
          ['moderate', ModerateReview],
          ['remove', RemoveReview],
        ].reduce(
          (b, [name, type]) => b.overrideProvider(type as never).useValue(stub(name as string)),
          fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
        ),
    }));
    for (const [accountId, population, label] of [
      [CUSTOMER, 'customer', 'shopper'],
      [ADMIN, 'admin', 'admin'],
    ] as const) {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population,
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: label,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    }
    // The admin's active second factor, for the admin step-up of the switch and the moderation.
    fakes.factors.set(ADMIN, {
      id: id<'SecondFactor'>(0xf301),
      marketId,
      accountId: ADMIN,
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

  /** A fresh step-up proof of the admin session (n = 2) for one action (identity's verify route). */
  const prove = (actionKey: string) =>
    fakes.stepUpProofs.set(`${code}|${id<'Session'>(0xf100 + 2)}|${actionKey}`, clock.now());
  function sessionOf(population: 'customer' | 'admin', n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      testMarketContext(code, PLATFORM_TENANT_ID),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId: population === 'customer' ? CUSTOMER : ADMIN,
        population,
        sellerId: null,
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
  const customer = () => sessionOf('customer', 1);
  const admin = () => sessionOf('admin', 2);

  const asAdmin = (method: 'get' | 'put', headers: Record<string, string>, payload?: unknown) => {
    const req = http()
      [method]('/reviews/admin/settings')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };
  const asCustomer = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](path)
      .set({ 'x-market-id': code, ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };

  const ownReview = {
    id: REVIEW,
    productId: PRODUCT,
    offerId: id<'Offer'>(0xe004),
    sellerId: id<'Seller'>(0xe005),
    rating: 5,
    title: 'Great',
    body: 'Fresh',
    locale: 'en-AU',
    anonymous: false,
    status: 'published',
    createdAt: START,
    editedAt: null,
    publishedAt: START,
    lastPurchaseAt: START,
    editableUntil: START.add({ hours: 24 }),
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok({ status: 'active', updatedAt: START });
  });
  afterEach(async () => {
    await app?.close();
  });

  it('lets an admin read and set the switch, and refuses a stray field, no CSRF and a non-JSON body', async () => {
    await boot();
    const session = admin();
    const read = await asAdmin('get', session);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({ status: 'active', updatedAt: START.toString() });
    prove('reviews.settings.change');
    expect((await asAdmin('put', session, { status: 'active' })).status).toBe(200);
    expect(calls).toEqual([
      { name: 'view-settings', input: {} },
      { name: 'set-status', input: { status: 'active' } },
    ]);
    expect((await asAdmin('put', { cookie: session.cookie }, { status: 'active' })).status).toBe(
      403,
    );
    prove('reviews.settings.change');
    const extra = await asAdmin('put', session, { status: 'active', enabled: true });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({
      details: { fields: [{ path: 'enabled', code: 'unknown-field' }] },
    });
    const text = await http()
      .put('/reviews/admin/settings')
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...session })
      .set('content-type', 'text/plain')
      .send('x');
    expect(text.status).toBe(415);
    next = err({ code: 'access.denied' });
    prove('reviews.settings.change');
    expect((await asAdmin('put', session, { status: 'off' })).status).toBe(403);
  });

  it('refuses the switch without a fresh step-up proof of the session', async () => {
    await boot();
    const session = admin();
    const refused = await asAdmin('put', session, { status: 'active' });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      statusCode: 403,
      code: 'second-factor.required',
      details: { actionKey: 'reviews.settings.change' },
    });
    // A proof for another action does not cover this one.
    prove('reviews.review.moderate');
    expect((await asAdmin('put', session, { status: 'active' })).status).toBe(403);
    expect(calls).toEqual([]);
    // The read needs no proof.
    expect((await asAdmin('get', session)).status).toBe(200);
  });

  describe('the moderator queue', () => {
    const REVIEW_ID = id<'ProductReview'>(0xe101);
    const base = '/reviews/admin/moderation';
    const asMod = (
      method: 'get' | 'post',
      path: string,
      headers: Record<string, string>,
      payload?: unknown,
    ) => {
      const req = http()
        [method](path)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers });
      return payload === undefined ? req : req.send(payload as object);
    };

    it('reads the queue and one review, no-store, with a closed query', async () => {
      await boot();
      const session = admin();
      next = ok({
        tab: 'held',
        items: [],
        nextCursor: null,
        counts: { held: 0, reported: 0, actioned: 0 },
      });
      const page = await asMod('get', `${base}?tab=held&limit=10`, session);
      expect(page.status).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toEqual({
        tab: 'held',
        items: [],
        nextCursor: null,
        counts: { held: 0, reported: 0, actioned: 0 },
      });
      expect(calls[0]).toEqual({ name: 'queue', input: { tab: 'held', limit: 10 } });
      const stray = await asMod('get', `${base}?x=1`, session);
      expect(stray.status).toBe(400);
      expect(stray.body).toMatchObject({
        details: { fields: [{ path: 'x', code: 'unknown-field' }] },
      });
      next = err({
        code: 'validation.failed',
        fields: [{ path: 'limit', code: 'range' }],
      });
      const bad = await asMod('get', `${base}?limit=abc`, session);
      expect(bad.status).toBe(400);
      expect(calls.at(-1)).toEqual({ name: 'queue', input: { limit: Number.NaN } });
      next = err({ code: 'reviews.not-found' });
      expect((await asMod('get', `${base}/${REVIEW_ID}`, session)).status).toBe(404);
      expect(calls.at(-1)).toEqual({ name: 'view-review', input: { reviewId: REVIEW_ID } });
    });

    it('refuses a customer and a signed-out caller', async () => {
      await boot();
      next = err({ code: 'access.unauthenticated' });
      const out = await asMod('get', base, {});
      expect(out.status).toBe(401);
      expect(out.body).toMatchObject({ code: 'access.unauthenticated' });
      next = err({ code: 'access.denied' });
      expect((await asMod('get', base, customer())).status).toBe(403);
    });

    it.each(['publish', 'hide', 'restore', 'remove'])(
      'asks %s for a fresh two-step proof and passes the closed body once it has one',
      async (action) => {
        await boot();
        const session = admin();
        const post = (payload: unknown = { reasonCode: 'spam' }) =>
          asMod('post', `${base}/${REVIEW_ID}/${action}`, session, payload);
        const refused = await post();
        expect(refused.status).toBe(403);
        expect(refused.body).toEqual({
          statusCode: 403,
          code: 'second-factor.required',
          details: { actionKey: 'reviews.review.moderate' },
        });
        expect(calls).toEqual([]);
        prove('reviews.review.moderate');
        next = err({ code: 'reviews.not-moderatable' });
        expect((await post()).status).toBe(409);
        expect(calls).toEqual([
          {
            name: action === 'remove' ? 'remove' : 'moderate',
            input: { reviewId: REVIEW_ID, action, reasonCode: 'spam' },
          },
        ]);
        prove('reviews.review.moderate');
        const stray = await post({ reasonCode: 'spam', note: 'x' });
        expect(stray.status).toBe(400);
        expect(stray.body).toMatchObject({
          details: { fields: [{ path: 'note', code: 'unknown-field' }] },
        });
        expect(
          (
            await asMod(
              'post',
              `${base}/${REVIEW_ID}/${action}`,
              { cookie: session.cookie },
              { reasonCode: 'spam' },
            )
          ).status,
        ).toBe(403);
      },
    );

    it('dismisses reports with no proof', async () => {
      await boot();
      const session = admin();
      next = err({ code: 'reviews.not-found' });
      const gone = await asMod('post', `${base}/${REVIEW_ID}/dismiss-reports`, session, {
        reasonCode: 'duplicate',
      });
      expect(gone.status).toBe(404);
      expect(calls).toEqual([
        {
          name: 'moderate',
          input: { reviewId: REVIEW_ID, action: 'dismiss-reports', reasonCode: 'duplicate' },
        },
      ]);
    });
  });

  it('submits a review: 201 when created, 200 when only the purchase was recorded, passing the body', async () => {
    await boot();
    const session = customer();
    next = ok({ outcome: 'created', review: ownReview });
    const created = await asCustomer('post', '/reviews/products', session, {
      productId: PRODUCT,
      rating: 5,
      body: 'Fresh',
    });
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body).toMatchObject({ outcome: 'created', review: { id: REVIEW, rating: 5 } });
    expect(calls).toEqual([
      { name: 'submit', input: { productId: PRODUCT, rating: 5, body: 'Fresh' } },
    ]);
    next = ok({ outcome: 'purchase-recorded', review: ownReview });
    expect(
      (await asCustomer('post', '/reviews/products', session, { productId: PRODUCT, rating: 5 }))
        .status,
    ).toBe(200);
  });

  it('refuses a stray field, a missing CSRF token and an admin session on the buyer routes', async () => {
    await boot();
    const session = customer();
    const stray = await asCustomer('post', '/reviews/products', session, {
      productId: PRODUCT,
      rating: 5,
      status: 'published',
    });
    expect(stray.status).toBe(400);
    expect(stray.body).toMatchObject({
      details: { fields: [{ path: 'status', code: 'unknown-field' }] },
    });
    expect(
      (
        await asCustomer(
          'post',
          '/reviews/products',
          { cookie: session.cookie },
          {
            productId: PRODUCT,
            rating: 5,
          },
        )
      ).status,
    ).toBe(403);
    next = err({ code: 'access.denied' });
    expect((await asCustomer('get', '/reviews/me', admin())).status).toBe(403);
    expect(calls.filter((c) => c.name === 'submit')).toEqual([]);
  });

  it('maps the refusals of the write routes to their statuses and bodies without any text', async () => {
    await boot();
    const session = customer();
    const submit = () =>
      asCustomer('post', '/reviews/products', session, { productId: PRODUCT, rating: 5 });
    for (const [refusal, status] of [
      ['reviews.disabled', 404],
      ['reviews.not-eligible', 403],
      ['reviews.own-store', 403],
      ['reviews.window-closed', 409],
      ['reviews.already-reviewed', 409],
      ['reviews.rate-limited', 429],
      ['reviews.unavailable', 503],
    ] as const) {
      next = err({ code: refusal });
      const res = await submit();
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ statusCode: status, code: refusal });
    }
    next = err({ code: 'validation.failed', fields: [{ path: 'rating', code: 'range' }] });
    const invalid = await submit();
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'rating', code: 'range' }] },
    });
  });

  it('edits, deletes and rates through the path ids', async () => {
    await boot();
    const session = customer();
    next = ok(ownReview);
    const edited = await asCustomer('patch', `/reviews/products/${REVIEW}`, session, { rating: 4 });
    expect(edited.status).toBe(200);
    next = ok({ id: REVIEW, status: 'deleted-by-author' });
    const deleted = await asCustomer('delete', `/reviews/products/${REVIEW}`, session);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ id: REVIEW, status: 'deleted-by-author' });
    next = ok({
      id: id<'SellerRating'>(0xe006),
      sellerOrderId: SELLER_ORDER,
      sellerId: id<'Seller'>(0xe005),
      satisfaction: 5,
      asDescribed: true,
      arrivedOk: true,
      reasonCode: null,
      status: 'published',
      createdAt: START,
    });
    const rated = await asCustomer(
      'post',
      `/reviews/seller-orders/${SELLER_ORDER}/rating`,
      session,
      { satisfaction: 5, asDescribed: true, arrivedOk: true },
    );
    expect(rated.status).toBe(201);
    expect(calls).toEqual([
      { name: 'edit', input: { rating: 4, reviewId: REVIEW } },
      { name: 'delete', input: { reviewId: REVIEW } },
      {
        name: 'rate',
        input: { satisfaction: 5, asDescribed: true, arrivedOk: true, sellerOrderId: SELLER_ORDER },
      },
    ]);
    next = err({ code: 'reviews.not-found' });
    expect(
      (await asCustomer('patch', `/reviews/products/${REVIEW}`, session, { rating: 4 })).status,
    ).toBe(404);
    next = err({ code: 'reviews.edit-window-closed' });
    expect(
      (await asCustomer('patch', `/reviews/products/${REVIEW}`, session, { rating: 4 })).status,
    ).toBe(409);
    next = err({ code: 'reviews.already-rated' });
    expect(
      (
        await asCustomer('post', `/reviews/seller-orders/${SELLER_ORDER}/rating`, session, {
          satisfaction: 5,
          asDescribed: true,
          arrivedOk: true,
        })
      ).status,
    ).toBe(409);
  });

  it('serves the buyer lists with no-store', async () => {
    await boot();
    const session = customer();
    next = ok({
      products: [
        {
          productId: PRODUCT,
          offerId: id<'Offer'>(0xe004),
          sellerId: id<'Seller'>(0xe005),
          sellerOrderId: SELLER_ORDER,
          deliveredAt: START,
          windowEndsAt: START.add({ hours: 24 }),
        },
      ],
      sellerOrders: [],
    });
    const todo = await asCustomer('get', '/reviews/me/to-review', session);
    expect(todo.status).toBe(200);
    expect(todo.headers['cache-control']).toBe('no-store');
    expect((todo.body as { products: unknown[] }).products).toHaveLength(1);
    next = ok({ reviews: [ownReview], sellerRatings: [] });
    const mine = await asCustomer('get', '/reviews/me', session);
    expect(mine.status).toBe(200);
    expect((mine.body as { reviews: unknown[] }).reviews).toHaveLength(1);
    next = err({ code: 'reviews.disabled' });
    expect((await asCustomer('get', '/reviews/me', session)).status).toBe(404);
  });

  it('serves the public reads to a visitor without a session, with a closed query', async () => {
    await boot();
    next = ok({
      reviews: [
        {
          id: REVIEW,
          rating: 5,
          title: 'Great',
          body: 'Fresh',
          locale: 'en-AU',
          author: { kind: 'verified-buyer' },
          boughtFrom: { offerId: id<'Offer'>(0xe004), sellerId: id<'Seller'>(0xe005) },
          publishedOn: '2026-10-25',
          editedOn: null,
        },
      ],
      nextCursor: null,
    });
    const page = await http()
      .get(`/reviews/products/${PRODUCT}?stars=5`)
      .set({ 'x-market-id': code });
    expect(page.status).toBe(200);
    expect(JSON.stringify(page.body)).not.toMatch(/accountId|email|orderId/i);
    expect((page.body as { reviews: object[] }).reviews[0]).toMatchObject({
      publishedOn: '2026-10-25',
      editedOn: null,
    });
    expect(JSON.stringify(page.body)).not.toContain('publishedAt');
    expect(calls).toEqual([
      {
        name: 'list-product-reviews',
        input: { productId: PRODUCT, stars: '5', sort: undefined, cursor: undefined },
      },
    ]);
    next = ok({
      productId: PRODUCT,
      count: 2,
      averageTimes100: 450,
      histogram: [0, 0, 0, 1, 1],
      shown: true,
    });
    const summary = await http()
      .get(`/reviews/products/${PRODUCT}/summary`)
      .set({ 'x-market-id': code });
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ count: 2, averageTimes100: 450, shown: true });
    next = ok({
      sellerId: id<'Seller'>(0xe005),
      count: 4,
      minimumCount: 3,
      meetsMinimum: true,
      averageTimes100: 400,
      histogram: [0, 0, 1, 2, 1],
      satisfiedBps: 7500,
      asDescribedBps: 10000,
      arrivedOkBps: 10000,
    });
    const seller = await http()
      .get(`/reviews/sellers/${id<'Seller'>(0xe005)}/summary`)
      .set({ 'x-market-id': code });
    expect(seller.status).toBe(200);
    expect(seller.body).toMatchObject({ count: 4, meetsMinimum: true });
    const typo = await http()
      .get(`/reviews/products/${PRODUCT}?page=2`)
      .set({ 'x-market-id': code });
    expect(typo.status).toBe(400);
    next = err({ code: 'reviews.disabled' });
    expect(
      (await http().get(`/reviews/products/${PRODUCT}/summary`).set({ 'x-market-id': code }))
        .status,
    ).toBe(404);
  });

  it('refuses a visitor on a buyer route', async () => {
    await boot();
    next = err({ code: 'access.unauthenticated' });
    const res = await http().get('/reviews/me').set({ 'x-market-id': code });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'access.unauthenticated' });
  });
});
