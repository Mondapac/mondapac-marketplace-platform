import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { markCollected, type SellerOrder } from './order';
import {
  hashesMatch,
  newPickupCode,
  parsePickupCode,
  PICKUP_MAX_FAILED_ATTEMPTS,
  pickupStatusOf,
} from './pickup-code';

// The pickup code and the handover step. Pure rules, no Market: the flows that use them run on AU
// and ZZ in pickup-code-use-cases.spec.ts.

const NOW = Temporal.Instant.from('2026-10-25T01:00:00Z');

describe('newPickupCode', () => {
  it('is always four digits, keeping leading zeros', () => {
    expect(newPickupCode(() => 0)).toBe('0000');
    expect(newPickupCode(() => 7)).toBe('0007');
    expect(newPickupCode(() => 427)).toBe('0427');
    expect(newPickupCode(() => 9999)).toBe('9999');
  });

  it('asks the source for a number below 10,000 and refuses an answer outside it', () => {
    let asked = 0;
    newPickupCode((max) => {
      asked = max;
      return 1;
    });
    expect(asked).toBe(10_000);
    expect(() => newPickupCode(() => 10_000)).toThrow(RangeError);
    expect(() => newPickupCode(() => -1)).toThrow(RangeError);
    expect(() => newPickupCode(() => 1.5)).toThrow(RangeError);
  });
});

describe('parsePickupCode', () => {
  it('takes exactly four ASCII digits', () => {
    expect(parsePickupCode('0427')).toBe('0427');
    for (const bad of [
      '',
      '042',
      '04277',
      '04 7',
      '+427',
      '٠٤٢٧',
      '0427\n',
      427,
      null,
      undefined,
    ]) {
      expect(parsePickupCode(bad)).toBeNull();
    }
  });
});

describe('hashesMatch', () => {
  it('is true for equal hashes only, and false for a different length', () => {
    expect(hashesMatch('abcd', 'abcd')).toBe(true);
    expect(hashesMatch('abcd', 'abce')).toBe(false);
    expect(hashesMatch('abcd', 'abc')).toBe(false);
    expect(hashesMatch('', '')).toBe(true);
  });
});

describe('pickupStatusOf', () => {
  it('counts the tries left and locks at the limit', () => {
    expect(pickupStatusOf({ failedAttempts: 0, lockedAt: null })).toEqual({
      attemptsLeft: PICKUP_MAX_FAILED_ATTEMPTS,
      locked: false,
    });
    expect(pickupStatusOf({ failedAttempts: 4, lockedAt: null })).toEqual({
      attemptsLeft: 1,
      locked: false,
    });
    expect(pickupStatusOf({ failedAttempts: 5, lockedAt: NOW })).toEqual({
      attemptsLeft: 0,
      locked: true,
    });
    // Five failures without the time yet is already locked (fail closed).
    expect(pickupStatusOf({ failedAttempts: 5, lockedAt: null }).locked).toBe(true);
  });
});

describe('markCollected', () => {
  const base: SellerOrder = {
    id: '01990000-0000-7000-8000-0000000000c1' as Id<'SellerOrder'>,
    sellerId: '01990000-0000-7000-8000-0000000000b1' as Id<'Seller'>,
    subtotal: 1000n,
    shipping: 0n,
    shippingTaxRateBps: null,
    shippingTax: null,
    shippingTaxInclusive: null,
    total: 1000n,
    fulfilment: 'to-ship',
    carrier: null,
    trackingRef: null,
    shippedAt: null,
    deliveredAt: null,
    inventoryRecordedAt: null,
    ledgerState: 'pending',
    deliveryMethod: 'pickup',
    deliveryWindow: null,
    readyAt: NOW,
    deliveryAttention: null,
  };

  it('delivers a ready pickup order in one step, with no carrier', () => {
    const later = NOW.add({ minutes: 30 });
    expect(markCollected(base, later)).toEqual({
      ...base,
      fulfilment: 'delivered',
      shippedAt: later,
      deliveredAt: later,
    });
  });

  it('refuses an order that is not ready, not a pickup, or already moved on', () => {
    expect(markCollected({ ...base, readyAt: null }, NOW)).toBeNull();
    expect(markCollected({ ...base, deliveryMethod: 'instant' }, NOW)).toBeNull();
    expect(markCollected({ ...base, fulfilment: 'delivered' }, NOW)).toBeNull();
    expect(markCollected({ ...base, fulfilment: 'shipped', carrier: 'X' }, NOW)).toBeNull();
  });
});
