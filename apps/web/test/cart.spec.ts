import { describe, expect, it } from 'vitest';
import { LINE_LIMIT, addOne, lineLimit, removeOne, summarise } from '../src/cart/cart.ts';

const aud = (amount: number) => ({ amount, currency: 'AUD' });
const nzd = (amount: number) => ({ amount, currency: 'NZD' });

describe('cart lines', () => {
  it('caps a line at the units left when stock is low, else at the default limit', () => {
    expect(lineLimit(3)).toBe(3);
    expect(lineLimit(undefined)).toBe(LINE_LIMIT);
    expect(lineLimit(40)).toBe(LINE_LIMIT);
    expect(lineLimit(0)).toBe(0);
  });

  it('adds up to the limit and no further', () => {
    let cart = addOne({}, 'a', aud(250), 2);
    cart = addOne(cart, 'a', aud(250), 2);
    const full = addOne(cart, 'a', aud(250), 2);
    expect(full).toBe(cart);
    expect(full.a?.quantity).toBe(2);
  });

  it('removes the line when its last unit goes', () => {
    const cart = removeOne(addOne({}, 'a', aud(250), 5), 'a');
    expect(cart).toEqual({});
    expect(removeOne(cart, 'missing')).toBe(cart);
  });

  it.each([
    ['AUD', aud],
    ['NZD', nzd],
  ])('totals in the currency of the lines (%s)', (currency, money) => {
    let cart = addOne({}, 'a', money(250), 5);
    cart = addOne(cart, 'a', money(250), 5);
    cart = addOne(cart, 'b', money(1099), 5);
    expect(summarise(cart)).toEqual({ count: 3, total: { amount: 1599, currency } });
    expect(summarise({})).toEqual({ count: 0, total: null });
  });
});
