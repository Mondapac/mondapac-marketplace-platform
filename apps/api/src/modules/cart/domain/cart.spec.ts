import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, SequenceIdGenerator } from '@mondapac/shared-kernel/testing';
import {
  addLine,
  isExpired,
  limitQuantity,
  mergeCarts,
  removeLine,
  setQuantity,
  transferToAccount,
  type CartLimits,
  type CartState,
} from './cart';

const T0 = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LATER = T0.add({ hours: 1 });
const clock = new FixedClock(T0);
const ids = new SequenceIdGenerator(clock);

// The two Market fixtures differ in currency and ceiling; the rules must not care.
describe.each([
  ['AU', 'AUD', { maxLineQuantity: 99, maxLines: 50 }],
  ['ZZ', 'JPY', { maxLineQuantity: 10, maxLines: 3 }],
] as const)('cart rules in market %s', (code, currency, limits: CartLimits) => {
  const price = (amount: bigint) => money(amount, currency);
  const empty = (
    owner: CartState['owner'] = { kind: 'account', accountId: ids.next<'Account'>() },
  ) =>
    ({
      id: ids.next<'Cart'>(),
      marketId: code,
      owner,
      status: 'active',
      lastChangedAt: T0,
      mergedIntoCartId: null,
      mergedAt: null,
      version: 1,
      createdAt: T0,
      lines: [],
    }) as unknown as CartState;
  const offer = ids.next<'Offer'>();
  const variant = ids.next<'Variant'>();
  const add = (
    cart: CartState,
    quantity: number,
    availability = null as never,
    o = offer,
    v = variant,
  ) =>
    addLine(
      cart,
      {
        offerId: o,
        variantId: v,
        quantity,
        unitPrice: price(1_000n),
        availability,
        newLineId: ids.next<'CartLine'>(),
      },
      limits,
      LATER,
    );

  it('adds a new line, then adds to it, limited by the ceiling', () => {
    const first = add(empty(), 3);
    if (!first.ok) throw new Error('expected ok');
    expect(first.cart.lines).toHaveLength(1);
    expect(first.cart.lines[0]).toMatchObject({
      quantity: 3,
      priceAtAdd: price(1_000n),
      addedAt: LATER,
    });
    expect(first.cart.lastChangedAt).toBe(LATER);

    const over = add(first.cart, limits.maxLineQuantity + 20);
    if (!over.ok) throw new Error('expected ok');
    expect(over.cart.lines[0]?.quantity).toBe(limits.maxLineQuantity);
    expect(over.clamped).toBe('market-ceiling');

    const again = add(over.cart, 1);
    if (!again.ok) throw new Error('expected ok');
    expect(again.changed).toBe(false);
    expect(again.cart).toBe(over.cart);
  });

  it('limits to onlyLeft only when the status is low', () => {
    const low = { status: 'low', onlyLeft: 4 } as const;
    expect(limitQuantity(9, limits, low)).toEqual({ quantity: 4, clamped: 'only-left' });
    expect(limitQuantity(9, limits, { status: 'in-stock', onlyLeft: null })).toEqual({
      quantity: 9,
      clamped: null,
    });
    expect(limitQuantity(limits.maxLineQuantity + 1, limits, null).clamped).toBe('market-ceiling');
  });

  it('refuses a new line over the line limit but still raises an existing one', () => {
    let cart = empty();
    const keys: [Id<'Offer'>, Id<'Variant'>][] = [];
    for (let i = 0; i < limits.maxLines; i += 1) {
      const k: [Id<'Offer'>, Id<'Variant'>] = [ids.next<'Offer'>(), ids.next<'Variant'>()];
      keys.push(k);
      const next = add(cart, 1, null as never, k[0], k[1]);
      if (!next.ok) throw new Error('expected ok');
      cart = next.cart;
    }
    expect(add(cart, 1, null as never, ids.next<'Offer'>(), ids.next<'Variant'>())).toEqual({
      ok: false,
      code: 'cart.too-many-lines',
    });
    const raised = add(cart, 1, null as never, keys[0]![0], keys[0]![1]);
    expect(raised.ok && raised.cart.lines[0]?.quantity).toBe(2);
  });

  it('changes a quantity absolutely, resets the price, and removes a line', () => {
    const first = add(empty(), 2);
    if (!first.ok) throw new Error('expected ok');
    const lineId = first.cart.lines[0]!.id;

    const changed = setQuantity(
      first.cart,
      lineId,
      5,
      price(1_200n),
      null,
      limits,
      LATER.add({ minutes: 1 }),
    );
    if (!changed.ok) throw new Error('expected ok');
    expect(changed.cart.lines[0]).toMatchObject({ quantity: 5, priceAtAdd: price(1_200n) });

    const same = setQuantity(changed.cart, lineId, 5, price(1_300n), null, limits, LATER);
    expect(same.ok && same.changed).toBe(false);
    expect(setQuantity(first.cart, 'nope', 1, null, null, limits, LATER)).toEqual({
      ok: false,
      code: 'cart.line-not-found',
    });

    const removed = removeLine(changed.cart, lineId, LATER);
    expect(removed.ok && removed.cart.lines).toEqual([]);
    expect(removeLine(changed.cart, 'nope', LATER)).toEqual({
      ok: false,
      code: 'cart.line-not-found',
    });
  });

  it('expires only a guest cart, seven days after its last change', () => {
    const week = 7 * 24 * 3_600_000;
    const guest = empty({ kind: 'guest', tokenHash: 'ab'.repeat(32) });
    expect(isExpired(guest, T0.add({ milliseconds: week - 1 }), week)).toBe(false);
    expect(isExpired(guest, T0.add({ milliseconds: week }), week)).toBe(true);
    expect(isExpired(empty(), T0.add({ milliseconds: 10 * week }), week)).toBe(false);
  });

  it('transfers a guest cart to an account', () => {
    const guest = empty({ kind: 'guest', tokenHash: 'cd'.repeat(32) });
    const account = ids.next<'Account'>();
    expect(transferToAccount(guest, account, LATER)).toMatchObject({
      owner: { kind: 'account', accountId: account },
      lastChangedAt: LATER,
    });
  });

  it('merges: sums shared lines (limited, earlier price kept), adds the rest oldest first', () => {
    const accountCart = (() => {
      const a = add(empty(), 4);
      if (!a.ok) throw new Error('expected ok');
      return {
        ...a.cart,
        lines: a.cart.lines.map((l) => ({
          ...l,
          addedAt: T0.add({ minutes: 5 }),
          priceAtAdd: price(900n),
        })),
      };
    })();
    const guestBase = empty({ kind: 'guest', tokenHash: 'ef'.repeat(32) });
    const extra = [ids.next<'Offer'>(), ids.next<'Variant'>()] as const;
    const guest: CartState = {
      ...guestBase,
      lines: [
        {
          id: ids.next<'CartLine'>(),
          offerId: extra[0],
          variantId: extra[1],
          quantity: 1,
          priceAtAdd: price(5n),
          addedAt: T0.add({ minutes: 9 }),
        },
        {
          id: ids.next<'CartLine'>(),
          offerId: offer,
          variantId: variant,
          quantity: limits.maxLineQuantity,
          priceAtAdd: price(700n),
          addedAt: T0.add({ minutes: 1 }),
        },
      ],
    };

    const merged = mergeCarts(accountCart, guest, limits, () => null, LATER);

    const shared = merged.account.lines.find((l) => l.offerId === offer)!;
    expect(shared).toMatchObject({ quantity: limits.maxLineQuantity, priceAtAdd: price(700n) });
    expect(merged.account.lines).toHaveLength(2);
    expect(merged.clamped).toEqual([
      { offerId: offer, variantId: variant, clamped: 'market-ceiling' },
    ]);
    expect(merged.guest).toMatchObject({
      status: 'merged',
      lines: [],
      mergedIntoCartId: accountCart.id,
      mergedAt: LATER,
    });
    expect(merged.notAdded).toEqual([]);
  });

  it('reports the guest lines it could not add at the line limit', () => {
    let account = empty();
    for (let i = 0; i < limits.maxLines; i += 1) {
      const next = add(account, 1, null as never, ids.next<'Offer'>(), ids.next<'Variant'>());
      if (!next.ok) throw new Error('expected ok');
      account = next.cart;
    }
    const lost = [ids.next<'Offer'>(), ids.next<'Variant'>()] as const;
    const guest: CartState = {
      ...empty({ kind: 'guest', tokenHash: '01'.repeat(32) }),
      lines: [
        {
          id: ids.next<'CartLine'>(),
          offerId: lost[0],
          variantId: lost[1],
          quantity: 1,
          priceAtAdd: price(1n),
          addedAt: T0,
        },
      ],
    };

    const merged = mergeCarts(account, guest, limits, () => null, LATER);

    expect(merged.account.lines).toHaveLength(limits.maxLines);
    expect(merged.notAdded).toEqual([{ offerId: lost[0], variantId: lost[1] }]);
  });
});
