import { describe, expect, it } from 'vitest';
import type { VariantPrice } from '../price/types.ts';
import type { StockCell } from '../stock/levels-types.ts';
import {
  changeLines,
  inlineOffersOf,
  plansOf,
  priceRange,
  rowEditing,
  stockTotal,
  withDraft,
  withoutSaved,
  type InlineOffer,
} from './offers-inline-logic.ts';

const O1 = '0190a000-0000-7000-8000-000000000001';
const O2 = '0190a000-0000-7000-8000-000000000002';
const V1 = '0190a000-0000-7000-8000-0000000000a1';
const V2 = '0190a000-0000-7000-8000-0000000000a2';
const S1 = '0190a000-0000-7000-8000-0000000000c1';
const S2 = '0190a000-0000-7000-8000-0000000000c2';

const price = (variantId: string, amount: string | null, over: Partial<VariantPrice> = {}) =>
  ({
    variantId,
    seriesVersion: amount === null ? null : 1,
    currency: 'AUD',
    inForce: amount === null ? null : { amount, effectiveFrom: '2026-11-01T00:00:00Z' },
    held: null,
    special: null,
    heldSpecial: null,
    retired: false,
    ...over,
  }) satisfies VariantPrice;
const cell = (variantId: string, sourceId: string, onHand: number, version: number | null = 1) =>
  ({ variantId, sourceId, onHand, held: 0, version: version ?? 0, retired: false }) as StockCell;

describe('inlineOffersOf', () => {
  it('takes the sizes from the stock read and the prices from the price read', () => {
    const offers = inlineOffersOf(
      {
        currency: 'AUD',
        offers: [{ offerId: O1, variants: [price(V1, '1790'), price(V2, null)] }],
      },
      { offers: [{ offerId: O1, variants: [{ variantId: V1, sources: [cell(V1, S1, 25)] }] }] },
    );

    const offer = offers.get(O1);
    expect(offer?.rows.map((row) => row.variantId)).toEqual([V1]);
    expect(offer?.rows[0]?.price?.inForce?.amount).toBe('1790');
    expect(offer?.rows[0]?.stock[S1]?.onHand).toBe(25);
    expect(offer?.sourceIds).toEqual([S1]);
  });

  it('uses the price read alone when stock is not shown, and answers nothing for an unread Offer', () => {
    const offers = inlineOffersOf(
      {
        currency: 'AUD',
        offers: [{ offerId: O1, variants: [price(V1, '950'), price(V2, '1790')] }],
      },
      null,
    );

    expect(offers.get(O1)?.rows).toHaveLength(2);
    expect(offers.get(O1)?.sourceIds).toEqual([]);
    expect(offers.has(O2)).toBe(false);
    expect(inlineOffersOf(null, null).size).toBe(0);
  });
});

describe('rowEditing', () => {
  const offer = (rows: number, sources: number, retired = false): InlineOffer => ({
    offerId: O1,
    rows: Array.from({ length: rows }, (_, i) => ({
      variantId: `v${i}`,
      label: '',
      price: price(`v${i}`, '100', { retired }),
      stock: {},
    })),
    sourceIds: Array.from({ length: sources }, (_, i) => `s${i}`),
  });

  it('edits one size with one location in the row', () => {
    expect(rowEditing(offer(1, 1))).toEqual({ price: true, stock: true, opens: null });
  });
  it('edits the price of one size in the row, and opens its locations', () => {
    expect(rowEditing(offer(1, 2))).toEqual({ price: true, stock: false, opens: 'locations' });
  });
  it('opens the sizes of an Offer with several', () => {
    expect(rowEditing(offer(3, 1))).toEqual({ price: false, stock: false, opens: 'sizes' });
  });
  it('edits nothing of a retired size', () => {
    expect(rowEditing(offer(1, 1, true))).toEqual({ price: false, stock: false, opens: null });
  });
});

describe('priceRange and stockTotal', () => {
  const rows = [
    { variantId: V1, label: '', price: price(V1, '1790'), stock: { [S1]: cell(V1, S1, 3) } },
    {
      variantId: V2,
      label: '',
      price: price(V2, '950'),
      stock: { [S1]: cell(V1, S1, 4), [S2]: cell(V1, S2, 5) },
    },
  ];

  it('answers the lowest and highest price in force, compared as numbers', () => {
    expect(priceRange(rows)).toEqual({ min: '950', max: '1790' });
    expect(
      priceRange([{ variantId: V1, label: '', price: price(V1, null), stock: {} }]),
    ).toBeNull();
  });
  it('adds every location of every size, and is null without stock', () => {
    expect(stockTotal(rows)).toBe(12);
    expect(stockTotal([{ variantId: V1, label: '', price: null, stock: {} }])).toBeNull();
  });
});

describe('plans, change lines and drafts', () => {
  const offers = inlineOffersOf(
    {
      currency: 'AUD',
      offers: [
        { offerId: O1, variants: [price(V1, '1790')] },
        { offerId: O2, variants: [price(V2, '950')] },
      ],
    },
    {
      offers: [
        { offerId: O1, variants: [{ variantId: V1, sources: [cell(V1, S1, 25)] }] },
        { offerId: O2, variants: [{ variantId: V2, sources: [cell(V2, S1, 0, null)] }] },
      ],
    },
  );

  it('sends only cells that differ, and keeps an invalid one back', () => {
    let prices = withDraft({}, O1, V1, '16.90');
    prices = withDraft(prices, O2, V2, '9.50');
    const stocks = withDraft({}, O1, `${V1}:${S1}`, 'lots');

    const plans = plansOf(offers, 'AUD', prices, stocks);

    expect(plans.map((plan) => plan.offer.offerId)).toEqual([O1]);
    expect(plans[0]?.writes).toEqual([{ kind: 'price', variantId: V1, amount: '1690' }]);
    expect(plans[0]?.invalid).toEqual([{ key: `${V1}:${S1}`, kind: 'stock' }]);
  });

  it('describes each write with its old value, none where nothing was saved', () => {
    const plans = plansOf(
      offers,
      'AUD',
      withDraft({}, O1, V1, '16.90'),
      withDraft(withDraft({}, O1, `${V1}:${S1}`, '60'), O2, `${V2}:${S1}`, '4'),
    );

    expect(changeLines(plans)).toEqual([
      { offerId: O1, variantId: V1, kind: 'price', from: '1790', to: '1690' },
      { offerId: O1, variantId: V1, kind: 'stock', from: '25', to: '60' },
      { offerId: O2, variantId: V2, kind: 'stock', from: '0', to: '4' },
    ]);
  });

  it('drops saved drafts unless they were typed again, and empty Offers with them', () => {
    const sent = withDraft(withDraft({}, O1, V1, '16.90'), O2, V2, '9.90');
    const now = withDraft(sent, O2, V2, '9.95');

    expect(withoutSaved(now, { [O1]: [V1], [O2]: [V2] }, sent)).toEqual({ [O2]: { [V2]: '9.95' } });
  });
});
