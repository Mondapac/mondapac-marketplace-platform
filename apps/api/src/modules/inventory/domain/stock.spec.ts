import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  availabilityOf,
  MAX_STOCK_LEVEL,
  parseStockLevel,
  recomputeSignal,
  sellableOf,
  sellableOfSellUnit,
  type StoredSignal,
} from './stock';

const NOW = Temporal.Instant.from('2026-10-09T01:00:00Z');
const SIGNAL = '0199c1a0-0000-7000-8000-000000000001' as Id<'AvailabilitySignal'>;
const NEW_SIGNAL = '0199c1a0-0000-7000-8000-000000000002' as Id<'AvailabilitySignal'>;
const OFFER = '0199c1a0-0000-7000-8000-000000000010' as Id<'Offer'>;
const VARIANT = '0199c1a0-0000-7000-8000-000000000011' as Id<'Variant'>;
const SELLER = '0199c1a0-0000-7000-8000-000000000012' as Id<'Seller'>;

describe('parseStockLevel', () => {
  it.each([0, 1, 250, MAX_STOCK_LEVEL])('accepts %i', (value) => {
    expect(parseStockLevel(value)).toBe(value);
  });

  it.each([-1, 1.5, MAX_STOCK_LEVEL + 1, Number.NaN, Infinity, '5', null, undefined, {}, 5n])(
    'refuses %p',
    (value) => {
      expect(parseStockLevel(value)).toBeNull();
    },
  );
});

describe('sellable quantity (design 4.1, Q10)', () => {
  it('is on hand minus held, never below 0', () => {
    expect(sellableOf(10, 3)).toBe(7);
    expect(sellableOf(2, 5)).toBe(0);
  });

  it('is the largest of the non-retired sources, not the sum', () => {
    expect(
      sellableOfSellUnit([
        { onHand: 4, held: 0, retired: false },
        { onHand: 9, held: 5, retired: false },
        { onHand: 100, held: 0, retired: true },
      ]),
    ).toBe(4);
  });

  it('is 0 with no item or only retired items (fail closed)', () => {
    expect(sellableOfSellUnit([])).toBe(0);
    expect(sellableOfSellUnit([{ onHand: 5, held: 0, retired: true }])).toBe(0);
  });
});

describe('availabilityOf (design 5.2, AC 7)', () => {
  it('is out at 0', () => {
    expect(availabilityOf(0, 10)).toEqual({ status: 'out', onlyLeft: null });
  });

  it('is low with the count at or below the threshold (threshold 5: 4 is low 4)', () => {
    expect(availabilityOf(4, 5)).toEqual({ status: 'low', onlyLeft: 4 });
    expect(availabilityOf(5, 5)).toEqual({ status: 'low', onlyLeft: 5 });
  });

  it('is in stock above the threshold (threshold 5: 7)', () => {
    expect(availabilityOf(7, 5)).toEqual({ status: 'in-stock', onlyLeft: null });
  });

  it('never shows a count with a threshold of 0', () => {
    expect(availabilityOf(1, 0)).toEqual({ status: 'in-stock', onlyLeft: null });
  });
});

describe('recomputeSignal (design 5.3)', () => {
  const stored = (over: Partial<StoredSignal>): StoredSignal => ({
    id: SIGNAL,
    status: 'in-stock',
    onlyLeft: null,
    version: 3,
    ...over,
  });
  const run = (storedSignal: StoredSignal | null, next: ReturnType<typeof availabilityOf>) =>
    recomputeSignal({
      stored: storedSignal,
      newId: NEW_SIGNAL,
      offerId: OFFER,
      variantId: VARIANT,
      sellerId: SELLER,
      next,
      now: NOW,
    });

  it('changes nothing when status and count are the same', () => {
    expect(run(stored({}), { status: 'in-stock', onlyLeft: null })).toEqual({ kind: 'unchanged' });
    expect(run(stored({ status: 'low', onlyLeft: 4 }), { status: 'low', onlyLeft: 4 })).toEqual({
      kind: 'unchanged',
    });
  });

  it('creates the signal at version 1 with one change event', () => {
    const change = run(null, { status: 'in-stock', onlyLeft: null });
    expect(change.kind).toBe('changed');
    if (change.kind !== 'changed') return;
    expect(change.created).toBe(true);
    expect(change.version).toBe(1);
    expect(change.events.map((e) => [e.type, e.aggregateId, e.aggregateVersion])).toEqual([
      ['inventory.availability-changed.v1', NEW_SIGNAL, 1],
    ]);
  });

  it('records a change of count inside low as one event at the next version', () => {
    const change = run(stored({ status: 'low', onlyLeft: 4 }), { status: 'low', onlyLeft: 3 });
    if (change.kind !== 'changed') throw new Error('expected a change');
    expect(change.created).toBe(false);
    expect(change.version).toBe(4);
    expect(change.events).toHaveLength(1);
    expect(change.events[0]?.payload).toMatchObject({ status: 'low', onlyLeft: 3 });
  });

  it('adds low-stock-reached on the first entry into low from in-stock, one version later', () => {
    const change = run(stored({}), { status: 'low', onlyLeft: 4 });
    if (change.kind !== 'changed') throw new Error('expected a change');
    expect(change.version).toBe(5);
    expect(change.events.map((e) => [e.type, e.aggregateVersion])).toEqual([
      ['inventory.availability-changed.v1', 4],
      ['inventory.low-stock-reached.v1', 5],
    ]);
    expect(change.events[1]?.payload).toEqual({
      sellerId: SELLER,
      offerId: OFFER,
      variantId: VARIANT,
      onlyLeft: 4,
    });
  });

  it.each(['out', 'low'] as const)('does not repeat low-stock-reached from %s', (from) => {
    const change = run(stored({ status: from, onlyLeft: from === 'low' ? 5 : null }), {
      status: 'low',
      onlyLeft: 4,
    });
    if (change.kind !== 'changed') throw new Error('expected a change');
    expect(change.events.map((e) => e.type)).toEqual(['inventory.availability-changed.v1']);
  });

  it('does not announce low for a signal created already low', () => {
    const change = run(null, { status: 'low', onlyLeft: 2 });
    if (change.kind !== 'changed') throw new Error('expected a change');
    expect(change.events.map((e) => e.type)).toEqual(['inventory.availability-changed.v1']);
  });

  it('carries no onlyLeft outside low', () => {
    const change = run(stored({ status: 'low', onlyLeft: 2 }), { status: 'out', onlyLeft: null });
    if (change.kind !== 'changed') throw new Error('expected a change');
    expect(change.events[0]?.payload).toMatchObject({ status: 'out', onlyLeft: null });
  });
});
