import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CartState } from '../domain/cart';
import type { SellerMinimum } from '../domain/cart-evaluator';
import { HmacRateCounterKeys } from '../infrastructure/hmac-rate-counter-keys';
import { InMemoryRateCounters } from './testing/in-memory-rate-counters';
import { CryptoGuestTokens } from '../infrastructure/crypto-guest-tokens';
import { ConfigCartPolicy } from '../infrastructure/config-cart-policy';
import type { CartDependencies } from './cart-operations';
import type { CartRepository } from './ports/cart.repository';
import { verdictKey, type LineFactsSource, type LineVerdict } from './ports/line-facts';
import { AddGuestItem } from './use-cases/add-guest-item.use-case';
import { AddItem } from './use-cases/add-item.use-case';
import { ClearOrderedLines } from './use-cases/clear-ordered-lines.use-case';
import { ReadCheckoutLines } from './use-cases/read-checkout-lines.use-case';
import { MergeGuestCart } from './use-cases/merge-guest-cart.use-case';
import { RemoveGuestItem } from './use-cases/remove-guest-item.use-case';
import { RemoveItem } from './use-cases/remove-item.use-case';
import { SetLineQuantity } from './use-cases/set-line-quantity.use-case';
import { ViewCart } from './use-cases/view-cart.use-case';
import { PurgeInactiveCarts } from './use-cases/purge-inactive-carts.use-case';
import { SetGuestLineQuantity } from './use-cases/set-guest-line-quantity.use-case';
import { ViewGuestCart } from './use-cases/view-guest-cart.use-case';

// The cart use cases in memory on both Market fixtures (AU 99 per line, AUD; ZZ 50, another
// currency): add with limits, stock clamp, guest cookie lifecycle, merge, price change, fail
// closed when a check is unavailable, and the customer-only gate.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
const T0 = Temporal.Instant.from('2026-10-09T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OFFER = id<'Offer'>(1);
const OFFER_B = id<'Offer'>(2);
const VARIANT = id<'Variant'>(3);
const SELLER = id<'Seller'>(4);
const ACCOUNT = id<'Account'>(5);
const ORIGIN = '203.0.113.7';

class MemoryCarts implements CartRepository {
  readonly rows = new Map<string, CartState>();
  findActiveByAccount(_m: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(
      [...this.rows.values()].find(
        (c) =>
          c.status === 'active' && c.owner.kind === 'account' && c.owner.accountId === accountId,
      ) ?? null,
    );
  }
  findByGuestHash(_m: MarketContext, hash: string) {
    return Promise.resolve(
      [...this.rows.values()].find((c) => c.owner.kind === 'guest' && c.owner.tokenHash === hash) ??
        null,
    );
  }
  insert(_m: MarketContext, cart: CartState) {
    this.rows.set(cart.id, cart);
    return Promise.resolve('inserted' as const);
  }
  save(_m: MarketContext, cart: CartState) {
    const stored = this.rows.get(cart.id);
    if (stored === undefined || stored.version !== cart.version)
      return Promise.resolve('stale' as const);
    this.rows.set(cart.id, { ...cart, version: cart.version + 1 });
    return Promise.resolve('saved' as const);
  }
  purgeInactive(
    _m: MarketContext,
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

describe.each([['AU'], ['ZZ']] as const)('cart use cases in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const ceiling = markets.get(market.marketId).maxLineQuantity;
  const currency = markets.get(market.marketId).defaultCurrency;
  const clock = new FixedClock(T0);
  let carts: MemoryCarts;
  let verdicts: Map<string, LineVerdict>;
  let factsDown: boolean;
  let minimums: Map<Id<'Seller'>, SellerMinimum>;
  let minimumCalls: number;
  let factCalls: number;
  let counters: InMemoryRateCounters;
  let deps: CartDependencies;

  const buyable = (
    amount: bigint,
    availability: LineVerdict['availability'] = null,
  ): LineVerdict => ({
    state: 'buyable',
    reason: null,
    sellerId: SELLER,
    unitPrice: money(amount, currency),
    taxInclusive: true,
    availability: availability ?? { status: 'in-stock', onlyLeft: null },
  });
  const facts: LineFactsSource = {
    evaluate: (_c, refs) => {
      factCalls += 1;
      const out = new Map<string, LineVerdict>();
      for (const ref of refs) {
        out.set(
          verdictKey(ref),
          factsDown
            ? {
                state: 'check-unavailable',
                reason: null,
                sellerId: null,
                unitPrice: null,
                taxInclusive: null,
                availability: null,
              }
            : (verdicts.get(verdictKey(ref)) ?? {
                state: 'unavailable',
                reason: 'offer-unavailable',
                sellerId: null,
                unitPrice: null,
                taxInclusive: null,
                availability: null,
              }),
        );
      }
      return Promise.resolve(out);
    },
    sellerMinimums: (_c, sellerIds) => {
      minimumCalls += 1;
      return Promise.resolve(
        new Map(
          sellerIds.map((sellerId) => [sellerId, minimums.get(sellerId) ?? { kind: 'unknown' }]),
        ),
      );
    },
  };

  beforeEach(() => {
    carts = new MemoryCarts();
    clock.set(T0);
    factsDown = false;
    factCalls = 0;
    minimumCalls = 0;
    minimums = new Map<Id<'Seller'>, SellerMinimum>([[SELLER, { kind: 'none' }]]);
    counters = new InMemoryRateCounters();
    verdicts = new Map([
      [verdictKey({ offerId: OFFER, variantId: VARIANT }), buyable(1000n)],
      [verdictKey({ offerId: OFFER_B, variantId: VARIANT }), buyable(250n)],
    ]);
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      carts,
      tokens: new CryptoGuestTokens(),
      policy: new ConfigCartPolicy(markets),
      facts,
      ids: new SequenceIdGenerator(clock),
      clock,
      counters,
      counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(7)),
    };
  });

  const guestCtx = testCallContext(market, 'anonymous', 'cart-0001-abcd');
  const customerCtx = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'customer',
      accountId: ACCOUNT,
      sessionId: id<'Session'>(6),
      sellerId: null,
    }),
    'cart-0002-abcd',
  );
  const sellerCtx = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: id<'Account'>(7),
      sessionId: id<'Session'>(8),
      sellerId: SELLER,
    }),
    'cart-0003-abcd',
  );
  const line = { offerId: OFFER, variantId: VARIANT };

  it('creates a guest cart on the first add, issues a token and keeps only its hash', async () => {
    const added = await new AddGuestItem(gate, deps).execute(guestCtx, {
      ...line,
      quantity: 2,
      token: null,
      origin: ORIGIN,
    });

    expect(added.ok && added.value.cookie?.action).toBe('set');
    const token = added.ok && added.value.cookie?.action === 'set' ? added.value.cookie.token : '';
    const [stored] = [...carts.rows.values()];
    expect(stored?.owner).toEqual({ kind: 'guest', tokenHash: deps.tokens.hashOf(token) });
    expect(
      JSON.stringify(stored, (_k, v) => (typeof v === 'bigint' ? v.toString() : (v as unknown))),
    ).not.toContain(token);
    expect(stored?.lines[0]?.quantity).toBe(2);
  });

  it('adds to the same line and limits the quantity to the Market ceiling', async () => {
    const add = new AddItem(gate, deps);
    await add.execute(customerCtx, { ...line, quantity: ceiling - 1 });
    const second = await add.execute(customerCtx, { ...line, quantity: 5 });

    expect(second.ok && second.value).toMatchObject({
      quantity: ceiling,
      changed: true,
      clamped: 'market-ceiling',
    });
    expect([...carts.rows.values()][0]?.lines).toHaveLength(1);
  });

  it('limits to what is left when the stock is low', async () => {
    verdicts.set(
      verdictKey({ offerId: OFFER, variantId: VARIANT }),
      buyable(1000n, { status: 'low', onlyLeft: 3 }),
    );

    const added = await new AddItem(gate, deps).execute(customerCtx, { ...line, quantity: 9 });

    expect(added.ok && added.value).toMatchObject({ quantity: 3, clamped: 'only-left' });
  });

  it.each([
    ['a zero quantity', { ...line, quantity: 0 }],
    ['a fractional quantity', { ...line, quantity: 1.5 }],
    ['a string quantity', { ...line, quantity: '2' as unknown as number }],
    ['a bad offer id', { offerId: 'x' as never, variantId: VARIANT, quantity: 1 }],
  ])('refuses %s without touching the store', async (_name, input) => {
    const added = await new AddItem(gate, deps).execute(customerCtx, input);

    expect(!added.ok && added.error.code).toBe('validation.failed');
    expect(carts.rows.size).toBe(0);
  });

  it('refuses an offer that cannot be bought, with the reason', async () => {
    const added = await new AddItem(gate, deps).execute(customerCtx, {
      offerId: id<'Offer'>(99),
      variantId: VARIANT,
      quantity: 1,
    });

    expect(!added.ok && added.error).toEqual({
      code: 'cart.offer-not-purchasable',
      reason: 'offer-unavailable',
    });
  });

  it('fails closed when a check is unavailable: no add, but the cart can still be shown', async () => {
    await new AddItem(gate, deps).execute(customerCtx, { ...line, quantity: 1 });
    factsDown = true;

    const added = await new AddItem(gate, deps).execute(customerCtx, { ...line, quantity: 1 });
    const viewed = await new ViewCart(gate, deps).execute(customerCtx, {});

    expect(!added.ok && added.error.code).toBe('cart.check-unavailable');
    expect(viewed.ok && viewed.value.groups[0]?.lines[0]?.state).toBe('check-unavailable');
    expect(viewed.ok && viewed.value.groups[0]?.subtotal).toBeNull();
  });

  it('groups by seller, sums the buyable lines and reports a price change', async () => {
    const add = new AddItem(gate, deps);
    await add.execute(customerCtx, { ...line, quantity: 2 });
    await add.execute(customerCtx, { offerId: OFFER_B, variantId: VARIANT, quantity: 4 });
    verdicts.set(verdictKey(line), buyable(1200n));

    const viewed = await new ViewCart(gate, deps).execute(customerCtx, {});

    expect(viewed.ok && viewed.value.groups).toHaveLength(1);
    const group = viewed.ok ? viewed.value.groups[0]! : undefined;
    expect(group?.subtotal).toEqual(money(2n * 1200n + 4n * 250n, currency));
    expect(group?.lines[0]?.priceChanged).toEqual({ previous: money(1000n, currency) });
    expect(group?.lines[1]?.priceChanged).toBeNull();
  });

  it('lowers an unbuyable line but refuses to raise it', async () => {
    const add = await new AddItem(gate, deps).execute(customerCtx, { ...line, quantity: 5 });
    const lineId = add.ok ? add.value.lineId! : '';
    verdicts.clear();

    const lower = await new SetLineQuantity(gate, deps).execute(customerCtx, {
      lineId,
      quantity: 2,
    });
    const raise = await new SetLineQuantity(gate, deps).execute(customerCtx, {
      lineId,
      quantity: 4,
    });

    expect(lower.ok && lower.value.quantity).toBe(2);
    expect(!raise.ok && raise.error).toEqual({
      code: 'cart.offer-not-purchasable',
      reason: 'offer-unavailable',
    });
  });

  it('removes a line and answers not-found for an unknown one', async () => {
    const add = await new AddItem(gate, deps).execute(customerCtx, { ...line, quantity: 1 });
    const lineId = add.ok ? add.value.lineId! : '';

    const removed = await new RemoveItem(gate, deps).execute(customerCtx, { lineId });
    const again = await new RemoveItem(gate, deps).execute(customerCtx, { lineId });

    expect(removed.ok).toBe(true);
    expect(!again.ok && again.error.code).toBe('cart.line-not-found');
  });

  it('shows an empty cart to a guest with a stale cookie and clears the cookie', async () => {
    const viewed = await new ViewGuestCart(gate, deps).execute(guestCtx, {
      token: new CryptoGuestTokens().issue().token,
    });

    expect(viewed.ok && viewed.value).toMatchObject({ lineCount: 0, cookie: { action: 'clear' } });
  });

  it('treats a malformed cookie as stale', async () => {
    const viewed = await new ViewGuestCart(gate, deps).execute(guestCtx, { token: '!' });

    expect(viewed.ok && viewed.value.cookie).toEqual({ action: 'clear' });
  });

  it('expires a guest cart seven days after its last change', async () => {
    const added = await new AddGuestItem(gate, deps).execute(guestCtx, {
      ...line,
      quantity: 1,
      token: null,
      origin: ORIGIN,
    });
    const token = added.ok && added.value.cookie?.action === 'set' ? added.value.cookie.token : '';
    clock.set(T0.add({ hours: 24 * 7 + 1 }));

    const viewed = await new ViewGuestCart(gate, deps).execute(guestCtx, { token });

    expect(viewed.ok && viewed.value).toMatchObject({ lineCount: 0, cookie: { action: 'clear' } });
  });

  it('never lets one guest read or change the cart of another', async () => {
    const mine = await new AddGuestItem(gate, deps).execute(guestCtx, {
      ...line,
      quantity: 1,
      token: null,
      origin: ORIGIN,
    });
    const lineId = mine.ok ? mine.value.lineId! : '';
    const stranger = new CryptoGuestTokens().issue().token;

    const removed = await new RemoveGuestItem(gate, deps).execute(guestCtx, {
      lineId,
      token: stranger,
      origin: ORIGIN,
    });

    expect(!removed.ok && removed.error.code).toBe('cart.line-not-found');
    expect([...carts.rows.values()][0]?.lines).toHaveLength(1);
  });

  it('moves a guest cart to a customer with none, and clears the cookie', async () => {
    const added = await new AddGuestItem(gate, deps).execute(guestCtx, {
      ...line,
      quantity: 2,
      token: null,
      origin: ORIGIN,
    });
    const token = added.ok && added.value.cookie?.action === 'set' ? added.value.cookie.token : '';

    const merged = await new MergeGuestCart(gate, deps).execute(customerCtx, { guestToken: token });

    expect(merged.ok && merged.value).toMatchObject({ merged: true, cookie: { action: 'clear' } });
    const mine = await new ViewCart(gate, deps).execute(customerCtx, {});
    expect(mine.ok && mine.value.lineCount).toBe(1);
    const replay = await new MergeGuestCart(gate, deps).execute(customerCtx, { guestToken: token });
    expect(replay.ok && replay.value.merged).toBe(false);
  });

  it('merges into an existing customer cart: quantities add up and stay under the ceiling', async () => {
    await new AddItem(gate, deps).execute(customerCtx, { ...line, quantity: ceiling - 1 });
    const added = await new AddGuestItem(gate, deps).execute(guestCtx, {
      ...line,
      quantity: 3,
      token: null,
      origin: ORIGIN,
    });
    const token = added.ok && added.value.cookie?.action === 'set' ? added.value.cookie.token : '';

    const merged = await new MergeGuestCart(gate, deps).execute(customerCtx, { guestToken: token });

    expect(merged.ok && merged.value.clamped).toEqual([{ ...line, clamped: 'market-ceiling' }]);
    const mine = [...carts.rows.values()].find((c) => c.owner.kind === 'account');
    expect(mine?.lines[0]?.quantity).toBe(ceiling);
    const replay = await new MergeGuestCart(gate, deps).execute(customerCtx, { guestToken: token });
    expect(replay.ok && replay.value.merged).toBe(false);
  });

  it('keeps the account use cases for customers only', async () => {
    const asSeller = await new AddItem(gate, deps).execute(sellerCtx, { ...line, quantity: 1 });
    const asGuest = await new AddItem(gate, deps).execute(guestCtx, { ...line, quantity: 1 });

    expect(!asSeller.ok && asSeller.error.code).toBe('access.denied');
    expect(!asGuest.ok).toBe(true);
    expect(carts.rows.size).toBe(0);
  });

  it('gives ordering the lines with their verdicts, and fails closed when a check is down', async () => {
    const add = new AddItem(gate, deps);
    await add.execute(customerCtx, { ...line, quantity: 2 });
    await add.execute(customerCtx, { offerId: OFFER_B, variantId: VARIANT, quantity: 1 });
    const read = new ReadCheckoutLines(gate, deps);

    const lines = await read.execute(customerCtx, {});
    expect(
      lines.ok && lines.value.map((l) => [l.offerId, l.quantity, l.state, l.sellerId]),
    ).toEqual([
      [OFFER, 2, 'buyable', SELLER],
      [OFFER_B, 1, 'buyable', SELLER],
    ]);
    expect(lines.ok && lines.value[0]?.unitPrice).toEqual(money(1000n, currency));

    factsDown = true;
    const down = await read.execute(customerCtx, {});
    expect(down.ok && down.value.every((l) => l.state === 'check-unavailable')).toBe(true);
    expect(await read.execute(guestCtx, {})).toMatchObject({ ok: false });
  });

  describe('minimum order per seller (cart design 6.4, 6.6; CRT-05)', () => {
    const minimum = (amount: bigint): SellerMinimum => ({
      kind: 'minimum',
      minimum: money(amount, currency),
    });
    const fill = async (quantity = 1) => {
      await new AddItem(gate, deps).execute(customerCtx, { ...line, quantity });
    };
    const groupOf = async () => {
      const viewed = await new ViewCart(gate, deps).execute(customerCtx, {});
      return viewed.ok ? viewed.value.groups[0]! : undefined;
    };

    it('shows the explicit none as any amount, without a minimum', async () => {
      await fill();

      expect((await groupOf())?.minimumOrder).toEqual({ state: 'none', minimum: null });
    });

    it('is below-minimum with the public minimum while the subtotal is under it, then met', async () => {
      minimums.set(SELLER, minimum(2500n));
      await fill(2); // 2 x 1000

      expect((await groupOf())?.minimumOrder).toEqual({
        state: 'below-minimum',
        minimum: money(2500n, currency),
      });

      await fill(1); // 3 x 1000 reaches it; adding more clears the state
      expect((await groupOf())?.minimumOrder).toEqual({
        state: 'met',
        minimum: money(2500n, currency),
      });
    });

    it('meets a minimum equal to the subtotal exactly', async () => {
      minimums.set(SELLER, minimum(2000n));
      await fill(2);

      expect((await groupOf())?.minimumOrder.state).toBe('met');
    });

    it('counts only the buyable lines against the minimum', async () => {
      minimums.set(SELLER, minimum(1500n));
      await fill(1);
      await new AddItem(gate, deps).execute(customerCtx, {
        offerId: OFFER_B,
        variantId: VARIANT,
        quantity: 1,
      });
      // The 1000 line becomes unbuyable: only the 250 line counts.
      verdicts.set(verdictKey(line), {
        ...buyable(1000n),
        state: 'unavailable',
        reason: 'out-of-stock',
      });

      expect((await groupOf())?.minimumOrder.state).toBe('below-minimum');
    });

    it('is not-applicable for a group without a buyable line, and asks sellers nothing', async () => {
      await fill();
      verdicts.set(verdictKey(line), {
        ...buyable(1000n),
        state: 'unavailable',
        reason: 'out-of-stock',
      });

      expect((await groupOf())?.minimumOrder).toEqual({ state: 'not-applicable', minimum: null });
      expect(minimumCalls).toBe(0);
    });

    it.each([
      ['an absent minimum', (m: Map<Id<'Seller'>, SellerMinimum>) => m.delete(SELLER)],
      [
        'a minimum in another currency',
        (m: Map<Id<'Seller'>, SellerMinimum>) =>
          m.set(SELLER, {
            kind: 'minimum',
            minimum: money(2500n, currency === 'AUD' ? 'JPY' : 'AUD'),
          }),
      ],
    ])('fails closed on %s: check-unavailable, never none', async (_name, change) => {
      await fill();
      change(minimums);

      expect((await groupOf())?.minimumOrder).toEqual({
        state: 'check-unavailable',
        minimum: null,
      });
    });

    it('fails closed when the lines of one seller mix tax conventions', async () => {
      await fill();
      await new AddItem(gate, deps).execute(customerCtx, {
        offerId: OFFER_B,
        variantId: VARIANT,
        quantity: 1,
      });
      verdicts.set(verdictKey({ offerId: OFFER_B, variantId: VARIANT }), {
        ...buyable(250n),
        taxInclusive: false,
      });

      expect((await groupOf())?.minimumOrder.state).toBe('check-unavailable');
    });

    it('asks sellers once per read for all sellers of buyable lines', async () => {
      await fill();
      await groupOf();

      expect(minimumCalls).toBe(1);
    });

    it('lets a ready cart through to ordering, and refuses with cart.not-ready and the sellers otherwise', async () => {
      const read = new ReadCheckoutLines(gate, deps);
      minimums.set(SELLER, minimum(2500n));
      await fill(2);

      const below = await read.execute(customerCtx, {});
      expect(below).toEqual({
        ok: false,
        error: {
          code: 'cart.not-ready',
          sellers: [{ sellerId: SELLER, reason: 'below-minimum', minimum: money(2500n, currency) }],
        },
      });

      minimums.delete(SELLER);
      const unknown = await read.execute(customerCtx, {});
      expect(unknown).toEqual({
        ok: false,
        error: {
          code: 'cart.not-ready',
          sellers: [{ sellerId: SELLER, reason: 'check-unavailable', minimum: null }],
        },
      });

      minimums.set(SELLER, minimum(2000n));
      expect((await read.execute(customerCtx, {})).ok).toBe(true);
    });
  });

  it('clears only the ordered units, for the system actor, and a repeat does nothing', async () => {
    const add = new AddItem(gate, deps);
    await add.execute(customerCtx, { ...line, quantity: 2 });
    await add.execute(customerCtx, { offerId: OFFER_B, variantId: VARIANT, quantity: 1 });
    const system = testCallContext(market, 'system', 'cart-0004-abcd');
    const clear = new ClearOrderedLines(gate, deps);

    const first = await clear.execute(system, { accountId: ACCOUNT, units: [line] });
    const again = await clear.execute(system, { accountId: ACCOUNT, units: [line] });
    const nobody = await clear.execute(system, { accountId: id<'Account'>(99), units: [line] });

    expect(first.ok && first.value.removed).toBe(1);
    expect(again.ok && again.value.removed).toBe(0);
    expect(nobody.ok && nobody.value.removed).toBe(0);
    expect([...carts.rows.values()][0]?.lines.map((l) => l.offerId)).toEqual([OFFER_B]);
    expect(await clear.execute(customerCtx, { accountId: ACCOUNT, units: [line] })).toMatchObject({
      ok: false,
    });
  });
  describe('guest write rate limits', () => {
    const guestAdd = (token: string | null, origin: string | null = ORIGIN, offer = OFFER) =>
      new AddGuestItem(gate, deps).execute(guestCtx, {
        offerId: offer,
        variantId: VARIANT,
        quantity: 1,
        token,
        origin,
      });
    const counts = (kind: string): number[] =>
      [...counters.rows].filter(([key]) => key.split('|')[1] === kind).map(([, row]) => row.count);
    const tokenOf = (res: Awaited<ReturnType<typeof guestAdd>>): string =>
      res.ok && res.value.cookie?.action === 'set' ? res.value.cookie.token : '';

    it('counts a creation and a write per origin on the first add, and a cart write after it', async () => {
      const first = await guestAdd(null);
      const token = tokenOf(first);
      await guestAdd(token);

      expect(counts('guest.create.origin.60min')).toEqual([1]);
      expect(counts('guest.write.origin.15min')).toEqual([2]);
      expect(counts('guest.write.cart.15min')).toEqual([1]);
    });

    it('throttles the 31st creation of an origin with the rest of the window, other origins pass', async () => {
      for (let n = 0; n < 30; n += 1) expect((await guestAdd(null)).ok).toBe(true);
      clock.advance(Temporal.Duration.from({ minutes: 10 }));
      const refused = await guestAdd(null);

      expect(refused).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 3000 },
      });
      expect(carts.rows.size).toBe(30);
      expect((await guestAdd(null, '203.0.113.8')).ok).toBe(true);
    });

    it('keeps the creation count when the add is then refused, and calls no facade before the count', async () => {
      verdicts.clear();
      const refused = await guestAdd(null);

      expect(refused).toMatchObject({ ok: false, error: { code: 'cart.offer-not-purchasable' } });
      expect(counts('guest.create.origin.60min')).toEqual([1]);
      expect(carts.rows.size).toBe(0);

      for (let n = 0; n < 29; n += 1) await guestAdd(null);
      factCalls = 0;
      const throttled = await guestAdd(null);
      expect(throttled).toMatchObject({ ok: false, error: { code: 'request.throttled' } });
      expect(factCalls).toBe(0);
    });

    it('limits writes per origin (120) across carts, and per cart (60) on its own', async () => {
      const token = tokenOf(await guestAdd(null));
      for (let n = 0; n < 60; n += 1) expect((await guestAdd(token)).ok).toBe(true);
      const perCart = await guestAdd(token);
      expect(perCart).toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: 900 },
      });
      // Another cart of the same origin is not affected by the first cart's count.
      const other = tokenOf(await guestAdd(null));
      expect((await guestAdd(other)).ok).toBe(true);
      // The origin counter (120 per 15 minutes) is shared by all carts of that origin.
      const rows = [...counters.rows].filter(([key]) => key.includes('guest.write.origin.15min'));
      for (const [, row] of rows) row.count = 120;
      expect((await guestAdd(other)).ok).toBe(false);
    });

    it('counts set-quantity and remove, and a removed line is still counted', async () => {
      const token = tokenOf(await guestAdd(null));
      const lineId = [...carts.rows.values()][0]!.lines[0]!.id;
      await new SetGuestLineQuantity(gate, deps).execute(guestCtx, {
        lineId,
        quantity: 3,
        token,
        origin: ORIGIN,
      });
      await new RemoveGuestItem(gate, deps).execute(guestCtx, { lineId, token, origin: ORIGIN });

      expect(counts('guest.write.cart.15min')).toEqual([2]);
      expect(counts('guest.write.origin.15min')).toEqual([3]);
      expect(counts('guest.create.origin.60min')).toEqual([1]);
    });

    it('restarts the window when it has ended', async () => {
      for (let n = 0; n < 31; n += 1) await guestAdd(null);
      clock.advance(Temporal.Duration.from({ minutes: 61 }));

      expect((await guestAdd(null)).ok).toBe(true);
    });

    it('fails closed with access.unavailable and writes nothing when the store or the origin is missing', async () => {
      counters.failing = true;
      const down = await guestAdd(null);
      counters.failing = false;
      const noOrigin = await guestAdd(null, null);

      expect(down).toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(noOrigin).toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(carts.rows.size).toBe(0);
      expect(counters.rows.size).toBe(0);
      expect(factCalls).toBe(0);
    });

    it('never stores the origin or the raw token in a counter key, and leaves reads and merges uncounted', async () => {
      const token = tokenOf(await guestAdd(null));
      await new ViewGuestCart(gate, deps).execute(guestCtx, { token });
      await new MergeGuestCart(gate, deps).execute(customerCtx, { guestToken: token });
      await new AddItem(gate, deps).execute(customerCtx, { ...line, quantity: 1 });

      const keys = [...counters.rows.keys()].join(' ');
      expect(keys).not.toContain(ORIGIN);
      expect(keys).not.toContain(token);
      expect(counts('guest.write.origin.15min')).toEqual([1]);
    });
  });

  describe('purge-inactive', () => {
    const system = testCallContext(market, 'system', 'cart-0009-abcd');
    const DAY = 24 * 60 * 60 * 1000;
    const cart = (
      n: number,
      owner: CartState['owner'],
      ageDays: number,
      status: CartState['status'] = 'active',
    ): CartState => ({
      id: id<'Cart'>(0x500 + n),
      marketId: market.marketId,
      owner,
      status,
      lastChangedAt: T0.subtract({ milliseconds: Math.round(ageDays * DAY) }),
      mergedIntoCartId: status === 'merged' ? id<'Cart'>(0x900) : null,
      mergedAt: status === 'merged' ? T0 : null,
      version: 1,
      createdAt: T0.subtract({ milliseconds: 100 * DAY }),
      lines: [],
    });
    const guest = (n: number): CartState['owner'] => ({ kind: 'guest', tokenHash: `h${n}` });
    const account = (n: number): CartState['owner'] => ({
      kind: 'account',
      accountId: id<'Account'>(0x700 + n),
    });
    const purge = () => new PurgeInactiveCarts(gate, { ...deps });

    it('deletes guest and merged carts after 7 days and account carts after 90, keeps fresh ones', async () => {
      for (const c of [
        cart(1, guest(1), 8),
        cart(2, guest(2), 6),
        cart(3, guest(3), 8, 'merged'),
        cart(4, account(4), 89),
        cart(5, account(5), 91),
      ]) {
        carts.rows.set(c.id, c);
      }

      const done = await purge().execute(system, {});

      expect(done.ok && done.value.carts).toBe(3);
      expect([...carts.rows.keys()].sort()).toEqual([id<'Cart'>(0x502), id<'Cart'>(0x504)].sort());
    });

    it('deletes in batches of 200, oldest first, up to the per-run cap, and prunes ended counters', async () => {
      for (let n = 0; n < 450; n += 1)
        carts.rows.set(`c${n}`, { ...cart(n, guest(n), 8 + n / 1000), id: `c${n}` as Id<'Cart'> });
      counters.rows.set('AU|guest.write.cart.15min|aa', {
        count: 3,
        windowStartedAt: T0.subtract({ minutes: 61 }),
      });
      counters.rows.set('AU|guest.write.cart.15min|bb', {
        count: 3,
        windowStartedAt: T0.subtract({ minutes: 10 }),
      });

      const done = await purge().execute(system, {});

      expect(done.ok && done.value).toEqual({ carts: 450, rateCounters: 1 });
      expect(carts.rows.size).toBe(0);
      expect([...counters.rows.keys()]).toEqual(['AU|guest.write.cart.15min|bb']);
    });

    it('does not report success when the counter prune or a batch fails', async () => {
      carts.rows.set('c1', { ...cart(1, guest(1), 8), id: 'c1' as Id<'Cart'> });
      counters.failing = true;
      expect(await purge().execute(system, {})).toEqual({
        ok: false,
        error: { code: 'cart.purge-failed' },
      });
      // The carts were still purged; only the prune failed.
      expect(carts.rows.size).toBe(0);
      counters.failing = false;
      carts.purgeInactive = () => Promise.reject(new Error('db down'));
      expect(await purge().execute(system, {})).toEqual({
        ok: false,
        error: { code: 'cart.purge-failed' },
      });
    });

    it('is for the system actor only', async () => {
      expect(await purge().execute(customerCtx, {})).toMatchObject({ ok: false });
      expect(await purge().execute(guestCtx, {})).toMatchObject({ ok: false });
    });
  });
});
