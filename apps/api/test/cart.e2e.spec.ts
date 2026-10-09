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
}

describe('cart routes over HTTP', () => {
  let app: NestExpressApplication | undefined;
  let carts: MemoryCarts;
  let clock: FixedClock;
  const http = () => request(app!.getHttpServer());

  async function boot(code: string) {
    const currency = code === 'AU' ? 'AUD' : 'JPY';
    const facts: LineFactsSource = {
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
          .overrideProvider(LINE_FACTS_SOURCE)
          .useValue(facts),
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
    groups: { subtotal: unknown; sellerId: string }[];
    details: { fields: unknown };
  }
  const json = (res: request.Response) => res.body as Answer;

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    carts = new MemoryCarts();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps every refusal code of the use cases to its exact status', () => {
    expect(CART_STATUS).toEqual({
      'validation.failed': 400,
      'cart.line-not-found': 404,
      'cart.offer-not-purchasable': 422,
      'cart.too-many-lines': 422,
      'conflict.stale': 409,
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

    it('refuses a merge with no session', async () => {
      await boot(code);

      const res = await http().post('/cart/merge').set({ 'x-market-id': code });

      expect(res.status).toBe(401);
    });
  });
});
