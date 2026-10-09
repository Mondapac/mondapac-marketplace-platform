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
import { CryptoGuestTokens } from '../infrastructure/crypto-guest-tokens';
import { ConfigCartPolicy } from '../infrastructure/config-cart-policy';
import type { CartDependencies } from './cart-operations';
import type { CartRepository } from './ports/cart.repository';
import { verdictKey, type LineFactsSource, type LineVerdict } from './ports/line-facts';
import { AddGuestItem } from './use-cases/add-guest-item.use-case';
import { AddItem } from './use-cases/add-item.use-case';
import { MergeGuestCart } from './use-cases/merge-guest-cart.use-case';
import { RemoveGuestItem } from './use-cases/remove-guest-item.use-case';
import { RemoveItem } from './use-cases/remove-item.use-case';
import { SetLineQuantity } from './use-cases/set-line-quantity.use-case';
import { ViewCart } from './use-cases/view-cart.use-case';
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
}

describe.each([['AU'], ['ZZ']] as const)('cart use cases in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const ceiling = markets.get(market.marketId).maxLineQuantity;
  const currency = markets.get(market.marketId).defaultCurrency;
  const clock = new FixedClock(T0);
  let carts: MemoryCarts;
  let verdicts: Map<string, LineVerdict>;
  let factsDown: boolean;
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
  };

  beforeEach(() => {
    carts = new MemoryCarts();
    factsDown = false;
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

  it('changes the quantity of an unbuyable line without a purchasability refusal', async () => {
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
    expect(raise.ok && raise.value.quantity).toBe(4);
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
    });
    const lineId = mine.ok ? mine.value.lineId! : '';
    const stranger = new CryptoGuestTokens().issue().token;

    const removed = await new RemoveGuestItem(gate, deps).execute(guestCtx, {
      lineId,
      token: stranger,
    });

    expect(!removed.ok && removed.error.code).toBe('cart.line-not-found');
    expect([...carts.rows.values()][0]?.lines).toHaveLength(1);
  });

  it('moves a guest cart to a customer with none, and clears the cookie', async () => {
    const added = await new AddGuestItem(gate, deps).execute(guestCtx, {
      ...line,
      quantity: 2,
      token: null,
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
});
