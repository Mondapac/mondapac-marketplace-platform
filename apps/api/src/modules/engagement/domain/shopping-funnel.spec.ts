import type { Id } from '@mondapac/shared-kernel';
import { shoppingFunnelOf } from './shopping-funnel';

const account = (n: number) =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Account'>;
const set = (...ns: number[]) => new Set(ns.map(account));

describe('shoppingFunnelOf', () => {
  it('counts each step only for accounts that did every step before it', () => {
    const out = shoppingFunnelOf(set(1, 2, 3, 4), set(1, 2, 3, 9), [
      { accountId: account(1), paid: true },
      { accountId: account(2), paid: false },
      // Placed an order without a cart addition of the day: not in the funnel's step.
      { accountId: account(4), paid: true },
      // Carted without viewing a product that day: not counted either.
      { accountId: account(9), paid: true },
    ]);
    expect(out).toEqual({ viewed: 4, carted: 3, checkedOut: 2, paid: 1 });
  });

  it('counts an account with two checkouts once, paid when either was paid', () => {
    const out = shoppingFunnelOf(set(1), set(1), [
      { accountId: account(1), paid: false },
      { accountId: account(1), paid: true },
    ]);
    expect(out).toEqual({ viewed: 1, carted: 1, checkedOut: 1, paid: 1 });
  });

  it('answers zeros for an empty day', () => {
    expect(shoppingFunnelOf(set(), set(), [])).toEqual({
      viewed: 0,
      carted: 0,
      checkedOut: 0,
      paid: 0,
    });
  });
});
