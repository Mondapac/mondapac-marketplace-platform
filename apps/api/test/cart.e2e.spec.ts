import type { NestExpressApplication } from '@nestjs/platform-express';
import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import {
  CART_REPOSITORY,
  type CartRepository,
} from '../src/modules/cart/application/ports/cart.repository';
import {
  LINE_FACTS_SOURCE,
  verdictKey,
  type LineFactsSource,
  type LineVerdict,
} from '../src/modules/cart/application/ports/line-facts';
import type { CartState } from '../src/modules/cart/domain/cart';
import type { SellerMinimum } from '../src/modules/cart/domain/cart-evaluator';
import { RATE_COUNTER_REPOSITORY } from '../src/modules/cart/application/ports/rate-counter.repository';
import { InMemoryRateCounters } from '../src/modules/cart/application/testing/in-memory-rate-counters';
import { SAVED_ITEM_REPOSITORY } from '../src/modules/cart/application/ports/saved-item.repository';
import { InMemorySavedItems } from '../src/modules/cart/application/testing/in-memory-saved-items';
import { CART_STATUS } from '../src/modules/cart/presentation/cart.controller';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// The cart routes over HTTP: the real guards, controller and use cases; the cart store and the
// facts of the other modules are in memory. Proves the guest cookie lifecycle (set, renewed,
// cleared; HttpOnly, Secure, `__Host-`, one per Market), the customer path with its CSRF token,
// `no-store`, closed bodies and the status of each refusal. The use cases have their own spec.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT = id<'Account'>(0xa101);
const OFFER = id<'Offer'>(0xc001);
const VARIANT = id<'Variant'>(0xc002);
const SELLER = id<'Seller'>(0xb020);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

class MemoryCarts implements CartRepository {
  readonly rows = new Map<string, CartState>();
  findActiveByAccount(_m: unknown, accountId: Id<'Account'>) {
    return Promise.resolve(
      [...this.rows.values()].find(
        (c) =>
          c.status === 'active' && c.owner.kind === 'account' && c.owner.accountId === accountId,
      ) ?? null,
    );
  }
  findByGuestHash(_m: unknown, hash: string) {
    return Promise.resolve(
      [...this.rows.values()].find((c) => c.owner.kind === 'guest' && c.owner.tokenHash === hash) ??
        null,
    );
  }
  insert(_m: unknown, cart: CartState) {
    this.rows.set(cart.id, cart);
    return Promise.resolve('inserted' as const);
  }
  save(_m: unknown, cart: CartState) {
    const stored = this.rows.get(cart.id);
    if (stored === undefined || stored.version !== cart.version)
      return Promise.resolve('stale' as const);
    this.rows.set(cart.id, { ...cart, version: cart.version + 1 });
    return Promise.resolve('saved' as const);
  }
  purgeInactive(
    _m: unknown,
    guestBefore: Temporal.Instant,
    accountBefore: Temporal.Instant,
    limit: number,
  ) {
    const expired = [...this.rows.values()]
      .filter(
        (c) =>
          Temporal.Instant.compare(
            c.lastChangedAt,
            c.owner.kind === 'guest' ? guestBefore : accountBefore,
          ) <= 0,
      )
      .sort((a, b) => Temporal.Instant.compare(a.lastChangedAt, b.lastChangedAt))
      .slice(0, limit);
    for (const cart of expired) this.rows.delete(cart.id);
    return Promise.resolve(expired.length);
  }
}

describe('cart routes over HTTP', () => {
  let app: NestExpressApplication | undefined;
  let carts: MemoryCarts;
  let saved: InMemorySavedItems;
  let counters: InMemoryRateCounters;
  let clock: FixedClock;
  /** What `sellers` says about the seller's minimum order (design 6.4); reset to none per test. */
  let sellerMinimum: SellerMinimum;
  const http = () => request(app!.getHttpServer());

  async function boot(code: string) {
    const currency = code === 'AU' ? 'AUD' : 'JPY';
    const facts: LineFactsSource = {
      sellerMinimums: (_c, sellerIds) =>
        Promise.resolve(new Map(sellerIds.map((sellerId) => [sellerId, sellerMinimum] as const))),
      sellerDeliveryFees: (_c, sellerIds) =>
        Promise.resolve(
          new Map(sellerIds.map((sellerId) => [sellerId, money(500n, currency)] as const)),
        ),
      evaluate: (_c, refs) =>
        Promise.resolve(
          new Map(
            refs.map((ref) => [
              verdictKey(ref),
              (ref.offerId === OFFER
                ? {
                    state: 'buyable',
                    reason: null,
                    sellerId: SELLER,
                    unitPrice: money(1500n, currency),
                    taxInclusive: true,
                    availability: { status: 'in-stock', onlyLeft: null },
                  }
                : {
                    state: 'unavailable',
                    reason: 'offer-unavailable',
                    sellerId: null,
                    unitPrice: null,
                    taxInclusive: null,
                    availability: null,
                  }) as LineVerdict,
            ]),
          ),
        ),
    };
    ({ app } = await createTestApp({
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(CART_REPOSITORY)
          .useValue(carts)
          .overrideProvider(RATE_COUNTER_REPOSITORY)
          .useValue(counters)
          .overrideProvider(LINE_FACTS_SOURCE)
          .useValue(facts)
          .overrideProvider(SAVED_ITEM_REPOSITORY)
          .useValue(saved),
    }));
  }

  function customerSession(code: string) {
    const marketId = code as AccountState['marketId'];
    fakes.seedAccount({
      id: ACCOUNT,
      marketId,
      population: 'customer',
      email: { typed: 'Shopper@Example.com', normalized: 'shopper@example.com' },
      displayName: null,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      { marketId, tenantId: 'default' } as never,
      openSession({
        id: id<'Session'>(0xf101),
        marketId,
        accountId: ACCOUNT,
        population: 'customer',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      sessionCookie: `__Host-session-customer-${code}=${issued.token}`,
      csrf: csrfTokenFor(issued.token),
    };
  }

  const setCookies = (res: request.Response): string[] =>
    (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const guestCookieValue = (res: request.Response, code: string): string | undefined => {
    const line = setCookies(res).find((c) => c.startsWith(`__Host-cart-guest-${code}=`));
    return line?.split(';', 1)[0]?.split('=')[1];
  };
  const line = { offerId: OFFER, variantId: VARIANT };
  interface Answer {
    lineCount: number;
    lineId: string;
    groups: {
      subtotal: unknown;
      sellerId: string;
      minimumOrder: { state: string; minimum: unknown };
      deliveryFee: unknown;
    }[];
    details: { fields: unknown };
  }
  const json = (res: request.Response) => res.body as Answer;

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    carts = new MemoryCarts();
    saved = new InMemorySavedItems();
    counters = new InMemoryRateCounters();
    sellerMinimum = { kind: 'none' };
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps every refusal code of the use cases to its exact status', () => {
    expect(CART_STATUS).toEqual({
      'validation.failed': 400,
      'cart.line-not-found': 404,
      'cart.saved-not-found': 404,
      'cart.saved-full': 422,
      'cart.offer-not-purchasable': 422,
      'cart.too-many-lines': 422,
      'conflict.stale': 409,
      'request.throttled': 429,
      'cart.check-unavailable': 503,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('serves an empty cart to a visitor with no cookie and sets none', async () => {
      await boot(code);

      const res = await http().get('/cart').set({ 'x-market-id': code });

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ groups: [], lineCount: 0 });
      expect(setCookies(res)).toEqual([]);
    });

    it('creates a guest cart on the first add with a hardened cookie, then reads it back', async () => {
      await boot(code);

      const added = await http()
        .post('/cart/items')
        .set({ 'x-market-id': code })
        .send({ ...line, quantity: 2 });

      expect(added.status).toBe(200);
      expect(added.body).toMatchObject({ quantity: 2, changed: true, clamped: null });
      const cookie = setCookies(added).find((c) => c.startsWith(`__Host-cart-guest-${code}=`))!;
      expect(cookie).toMatch(/; Max-Age=604800; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
      const token = guestCookieValue(added, code)!;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(
        JSON.stringify([...carts.rows.values()], (_k, v) =>
          typeof v === 'bigint' ? v.toString() : (v as unknown),
        ),
      ).not.toContain(token);

      const viewed = await http()
        .get('/cart')
        .set({ 'x-market-id': code, cookie: `__Host-cart-guest-${code}=${token}` });
      expect(viewed.status).toBe(200);
      expect(json(viewed).lineCount).toBe(1);
      expect(json(viewed).groups[0]!.subtotal).toEqual({
        amount: '3000',
        currency: code === 'AU' ? 'AUD' : 'JPY',
      });
      expect(json(viewed).groups[0]!.sellerId).toBe(SELLER);
    });

    it('shows the minimum-order state of each seller group, and clears it once the minimum is met', async () => {
      await boot(code);
      const currency = code === 'AU' ? 'AUD' : 'JPY';
      sellerMinimum = { kind: 'minimum', minimum: money(4000n, currency) };
      const added = await http()
        .post('/cart/items')
        .set({ 'x-market-id': code })
        .send({ ...line, quantity: 2 }); // 2 x 1500 = 3000
      const cookie = `__Host-cart-guest-${code}=${guestCookieValue(added, code)!}`;

      const below = await http().get('/cart').set({ 'x-market-id': code, cookie });
      expect(json(below).groups[0]!.minimumOrder).toEqual({
        state: 'below-minimum',
        minimum: { amount: '4000', currency },
      });
      // The seller's flat delivery fee is shown to a guest before sign-in.
      expect(json(below).groups[0]!.deliveryFee).toEqual({ amount: '500', currency });

      await http()
        .post('/cart/items')
        .set({ 'x-market-id': code, cookie })
        .send({ ...line, quantity: 1 }); // 4500
      const met = await http().get('/cart').set({ 'x-market-id': code, cookie });
      expect(json(met).groups[0]!.minimumOrder).toEqual({
        state: 'met',
        minimum: { amount: '4000', currency },
      });
    });

    it('shows none as no minimum and an unknown minimum as check-unavailable, with no minimum', async () => {
      await boot(code);
      const added = await http()
        .post('/cart/items')
        .set({ 'x-market-id': code })
        .send({ ...line, quantity: 1 });
      const cookie = `__Host-cart-guest-${code}=${guestCookieValue(added, code)!}`;

      const none = await http().get('/cart').set({ 'x-market-id': code, cookie });
      expect(json(none).groups[0]!.minimumOrder).toEqual({ state: 'none', minimum: null });

      sellerMinimum = { kind: 'unknown' };
      const unknown = await http().get('/cart').set({ 'x-market-id': code, cookie });
      expect(json(unknown).groups[0]!.minimumOrder).toEqual({
        state: 'check-unavailable',
        minimum: null,
      });
    });

    it('renews the cookie on a guest write and refuses another market’s cookie as stale', async () => {
      await boot(code);
      const other = code === 'AU' ? 'ZZ' : 'AU';
      const added = await http()
        .post('/cart/items')
        .set({ 'x-market-id': code })
        .send({ ...line, quantity: 1 });
      const token = guestCookieValue(added, code)!;

      const again = await http()
        .post('/cart/items')
        .set({ 'x-market-id': code, cookie: `__Host-cart-guest-${code}=${token}` })
        .send({ ...line, quantity: 1 });
      const viaOther = await http()
        .get('/cart')
        .set({ 'x-market-id': other, cookie: `__Host-cart-guest-${code}=${token}` });

      expect(again.body).toMatchObject({ quantity: 2 });
      expect(guestCookieValue(again, code)).toBe(token);
      expect(json(viaOther).lineCount).toBe(0);
    });

    it('clears a stale or malformed guest cookie on a read', async () => {
      await boot(code);

      const res = await http()
        .get('/cart')
        .set({ 'x-market-id': code, cookie: `__Host-cart-guest-${code}=not-a-token` });

      expect(json(res).lineCount).toBe(0);
      expect(setCookies(res).find((c) => c.startsWith(`__Host-cart-guest-${code}=;`))).toMatch(
        /Max-Age=0/,
      );
    });

    it('throttles the 31st guest cart creation of an origin with 429 and Retry-After', async () => {
      await boot(code);
      const add = () =>
        http()
          .post('/cart/items')
          .set({ 'x-market-id': code })
          .send({ ...line, quantity: 1 });

      for (let n = 0; n < 30; n += 1) expect((await add()).status).toBe(200);
      const throttled = await add();

      expect(throttled.status).toBe(429);
      expect(throttled.body).toMatchObject({
        code: 'request.throttled',
        details: { retryAfterSeconds: 3600 },
      });
      expect(throttled.headers['retry-after']).toBe('3600');
      expect(setCookies(throttled)).toEqual([]);
      expect(carts.rows.size).toBe(30);
      // Viewing is never throttled.
      expect((await http().get('/cart').set({ 'x-market-id': code })).status).toBe(200);
    });

    it('fails closed with 503 access.unavailable and writes nothing when the counters are down', async () => {
      await boot(code);
      counters.failing = true;

      const res = await http()
        .post('/cart/items')
        .set({ 'x-market-id': code })
        .send({ ...line, quantity: 1 });

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'access.unavailable' });
      expect(carts.rows.size).toBe(0);
      expect(setCookies(res)).toEqual([]);
    });

    it('refuses bodies that are not closed JSON, and sets no cookie on a refusal', async () => {
      await boot(code);
      const post = (body: unknown, type = 'application/json') =>
        http()
          .post('/cart/items')
          .set({ 'x-market-id': code, 'content-type': type })
          .send(body as never);

      const extra = await post({ ...line, quantity: 1, sellerId: SELLER });
      const text = await post('offerId=1', 'text/plain');
      const bad = await post({ ...line, quantity: 0 });
      const missing = await post({ ...line, quantity: 1, offerId: id<'Offer'>(0x99) });

      expect(extra.status).toBe(400);
      expect(json(extra).details.fields).toEqual([{ path: 'sellerId', code: 'unknown-field' }]);
      expect(text.status).toBe(415);
      expect(bad.status).toBe(400);
      expect(missing.status).toBe(422);
      expect(missing.body).toMatchObject({
        code: 'cart.offer-not-purchasable',
        details: { reason: 'offer-unavailable' },
      });
      for (const res of [extra, text, bad, missing]) expect(setCookies(res)).toEqual([]);
    });

    it('changes and removes a line of the guest cart', async () => {
      await boot(code);
      const added = await http()
        .post('/cart/items')
        .set({ 'x-market-id': code })
        .send({ ...line, quantity: 1 });
      const cookie = `__Host-cart-guest-${code}=${guestCookieValue(added, code)!}`;
      const lineId = json(added).lineId;

      const set = await http()
        .put(`/cart/items/${lineId}`)
        .set({ 'x-market-id': code, cookie })
        .send({ quantity: 4 });
      const gone = await http()
        .delete(`/cart/items/${lineId}`)
        .set({ 'x-market-id': code, cookie });
      const missing = await http()
        .delete(`/cart/items/${lineId}`)
        .set({ 'x-market-id': code, cookie });

      expect(set.body).toMatchObject({ quantity: 4, changed: true });
      expect(gone.body).toEqual({ removed: true });
      expect(missing.status).toBe(404);
    });

    it('serves a signed-in customer from the session, with the CSRF token on writes', async () => {
      await boot(code);
      const { sessionCookie, csrf } = customerSession(code);
      const headers = { 'x-market-id': code, cookie: sessionCookie };

      const noToken = await http()
        .post('/cart/items')
        .set(headers)
        .send({ ...line, quantity: 1 });
      const added = await http()
        .post('/cart/items')
        .set({ ...headers, 'x-csrf-token': csrf })
        .send({ ...line, quantity: 3 });
      const viewed = await http().get('/cart').set(headers);

      expect(noToken.status).toBe(403);
      expect(added.status).toBe(200);
      expect(setCookies(added)).toEqual([]);
      expect(json(viewed).lineCount).toBe(1);
      expect([...carts.rows.values()][0]?.owner).toEqual({ kind: 'account', accountId: ACCOUNT });
    });

    it('merges the guest cart into the customer cart after sign-in and clears the cookie', async () => {
      await boot(code);
      const added = await http()
        .post('/cart/items')
        .set({ 'x-market-id': code })
        .send({ ...line, quantity: 2 });
      const guest = `__Host-cart-guest-${code}=${guestCookieValue(added, code)!}`;
      const { sessionCookie, csrf } = customerSession(code);

      const merged = await http()
        .post('/cart/merge')
        .set({ 'x-market-id': code, cookie: `${sessionCookie}; ${guest}`, 'x-csrf-token': csrf });

      expect(merged.status).toBe(200);
      expect(merged.body).toMatchObject({ merged: true });
      expect(setCookies(merged).find((c) => c.startsWith(`__Host-cart-guest-${code}=;`))).toMatch(
        /Max-Age=0/,
      );
      const viewed = await http().get('/cart').set({ 'x-market-id': code, cookie: sessionCookie });
      expect(json(viewed).lineCount).toBe(1);
    });

    it('moves a line to the saved list and back for a signed-in customer only', async () => {
      await boot(code);
      const currency = code === 'AU' ? 'AUD' : 'JPY';
      const { sessionCookie, csrf } = customerSession(code);
      const read = { 'x-market-id': code, cookie: sessionCookie };
      const write = { ...read, 'x-csrf-token': csrf };
      await http()
        .post('/cart/items')
        .set(write)
        .send({ ...line, quantity: 2 });
      const lineId = (
        json(await http().get('/cart').set(read)) as unknown as {
          groups: { lines: { lineId: string }[] }[];
        }
      ).groups[0]!.lines[0]!.lineId;

      const noToken = await http().post('/cart/saved').set(read).send({ lineId });
      const moved = await http().post('/cart/saved').set(write).send({ lineId });
      const list = await http().get('/cart/saved').set(read);
      const savedId = (moved.body as { savedId: string }).savedId;
      const guest = await http().get('/cart/saved').set({ 'x-market-id': code });
      const stray = await http().post('/cart/saved').set(write).send({ lineId, quantity: 1 });

      expect(noToken.status).toBe(403);
      expect(moved.status).toBe(200);
      expect(list.headers['cache-control']).toBe('no-store');
      expect(list.body).toEqual({
        items: [
          {
            savedId,
            offerId: OFFER,
            variantId: line.variantId,
            savedAt: START.toString(),
            state: 'buyable',
            reason: null,
            sellerId: SELLER,
            unitPrice: { amount: '1500', currency },
            availability: { status: 'in-stock', onlyLeft: null },
          },
        ],
      });
      expect(json(await http().get('/cart').set(read)).lineCount).toBe(0);
      expect(guest.status).toBe(401);
      expect(stray.status).toBe(400);

      const back = await http().post(`/cart/saved/${savedId}/move-to-cart`).set(write);
      expect(back.status).toBe(200);
      expect(back.body).toMatchObject({ quantity: 1 });
      expect(json(await http().get('/cart').set(read)).lineCount).toBe(1);

      const gone = await http().delete(`/cart/saved/${savedId}`).set(write);
      const bad = await http().delete('/cart/saved/nope').set(write);
      expect(gone.status).toBe(404);
      expect(gone.body).toEqual({ statusCode: 404, code: 'cart.saved-not-found' });
      expect(bad.status).toBe(400);
    });

    it('refuses a merge with no session', async () => {
      await boot(code);

      const res = await http().post('/cart/merge').set({ 'x-market-id': code });

      expect(res.status).toBe(401);
    });
  });
});
