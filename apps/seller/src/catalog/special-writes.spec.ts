import { describe, expect, it } from 'vitest';
import type { VariantPrice } from '../price/types.ts';
import {
  orderedWrites,
  specialWritesOf,
  type PriceWrite,
  type TableRow,
} from './variants-table-logic.ts';

// The pure half of the special price in a size's Details (Offer page PR 6): what a save sends,
// what it refuses before sending, and in which order, for two Market fixtures.

const price = (over: Partial<VariantPrice> = {}): VariantPrice => ({
  variantId: 'v',
  seriesVersion: 3,
  currency: 'AUD',
  inForce: { amount: '1000', effectiveFrom: '2026-01-01T00:00:00Z' },
  held: null,
  special: null,
  heldSpecial: null,
  retired: false,
  ...over,
});
const row = (variantId: string, over: Partial<VariantPrice> = {}): TableRow => ({
  variantId,
  label: variantId,
  price: price({ variantId, ...over }),
  stock: {},
});

describe.each([
  {
    currency: 'AUD',
    zone: 'Australia/Brisbane',
    amount: '8.50',
    minor: '850',
    end: '2026-12-01T00:00:00Z',
  },
  // A synthetic Market: no minor units, another zone (UTC+4 all year).
  { currency: 'JPY', zone: 'Asia/Dubai', amount: '850', minor: '850', end: '2026-12-01T06:00:00Z' },
])('specialWritesOf in $currency', ({ currency, zone, amount, minor, end }) => {
  it('sends one write for a size with an amount and an end, read in the seller zone', () => {
    const { writes, invalid } = specialWritesOf([row('v1')], currency, zone, {
      v1: { amount, start: '', end: '2026-12-01T10:00' },
    });
    expect(invalid).toEqual([]);
    expect(writes).toEqual([
      { kind: 'special', variantId: 'v1', amount: minor, startsAt: null, endsAt: end },
    ]);
  });

  it('names every wrong field and sends nothing for that size', () => {
    const { writes, invalid } = specialWritesOf([row('v1')], currency, zone, {
      v1: { amount: 'abc', start: 'soon', end: '' },
    });
    expect(writes).toEqual([]);
    expect(invalid.map((item) => item.kind)).toEqual([
      'special-amount',
      'special-start',
      'special-end',
    ]);
  });

  it('starts now a start already past, and sends nothing for a size without a regular price', () => {
    const now = Date.parse('2026-12-01T00:00:30Z');
    const draft = { amount, start: '2026-12-01T10:00', end: '2026-12-08T10:00' };
    const sameMinute = specialWritesOf(
      [row('v1')],
      currency,
      'Australia/Brisbane',
      { v1: draft },
      undefined,
      now,
    );
    expect(sameMinute.writes[0]?.startsAt).toBeNull();
    const noRegular = specialWritesOf([row('v1', { inForce: null })], currency, zone, {
      v1: draft,
    });
    expect(noRegular).toEqual({ writes: [], invalid: [] });
  });

  it('skips untouched sizes and sizes no longer sold', () => {
    const { writes, invalid } = specialWritesOf(
      [row('v1'), row('v2', { retired: true })],
      currency,
      zone,
      {
        v1: { amount: '', start: '', end: '' },
        v2: { amount, start: '', end: '2026-12-01T10:00' },
      },
    );
    expect(writes).toEqual([]);
    expect(invalid).toEqual([]);
  });
});

describe('orderedWrites', () => {
  const special = {
    kind: 'special' as const,
    variantId: 'v1',
    amount: '500',
    startsAt: null,
    endsAt: '2026-12-01T00:00:00Z',
  };
  const regular = (amount: string): PriceWrite => ({ kind: 'price', variantId: 'v1', amount });
  const running = row('v1', {
    special: {
      amount: '800',
      startsAt: '2026-11-01T00:00:00Z',
      endsAt: '2026-12-30T00:00:00Z',
      state: 'running',
    },
  });

  it('sends a special after its size’s new regular price', () => {
    expect(orderedWrites([running], [regular('1200')], [special])).toEqual([
      regular('1200'),
      special,
    ]);
  });

  it('sends the special first when the new regular price is not above the current special', () => {
    expect(orderedWrites([running], [regular('800')], [special])).toEqual([
      special,
      regular('800'),
    ]);
  });
});
