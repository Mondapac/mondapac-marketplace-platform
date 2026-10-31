import { Temporal } from '@mondapac/shared-kernel';
import { cashbackAmount, creditKey, creditModeFor, shareOf, wholeDaysBetween } from './credit';

const base = {
  goodsPaid: 10000n,
  bps: 500,
  capMinor: 2000n,
  alreadyCreditedForOrder: 0n,
  minSpendMinor: null,
  budgetLeft: null,
};

describe('shareOf', () => {
  it('floors and is never negative', () => {
    expect(shareOf(999n, 500)).toBe(49n);
    expect(shareOf(0n, 500)).toBe(0n);
    expect(shareOf(-5n, 500)).toBe(0n);
    expect(shareOf(10000n, 10000)).toBe(10000n);
  });
});

describe('cashbackAmount', () => {
  it('is the percent of the goods paid, floored', () => {
    expect(cashbackAmount(base)).toBe(500n);
    expect(cashbackAmount({ ...base, goodsPaid: 1999n })).toBe(99n);
  });

  it('stops at what is left of the per-order cap, across seller orders', () => {
    expect(cashbackAmount({ ...base, goodsPaid: 1000000n })).toBe(2000n);
    expect(cashbackAmount({ ...base, goodsPaid: 1000000n, alreadyCreditedForOrder: 1500n })).toBe(
      500n,
    );
    expect(cashbackAmount({ ...base, alreadyCreditedForOrder: 2000n })).toBe(0n);
    expect(cashbackAmount({ ...base, alreadyCreditedForOrder: 9000n })).toBe(0n);
  });

  it('stops at the budget left and at the minimum spend', () => {
    expect(cashbackAmount({ ...base, budgetLeft: 120n })).toBe(120n);
    expect(cashbackAmount({ ...base, budgetLeft: 0n })).toBe(0n);
    expect(cashbackAmount({ ...base, minSpendMinor: 10001n })).toBe(0n);
    expect(cashbackAmount({ ...base, minSpendMinor: 10000n })).toBe(500n);
  });
});

describe('creditModeFor', () => {
  it('records the credit of a test-mode promotion and never calls the wallet for it', () => {
    for (const gstRulingConfirmed of [true, false]) {
      for (const orderIsTest of [true, false]) {
        expect(creditModeFor({ promotionTestMode: true, orderIsTest, gstRulingConfirmed })).toBe(
          'RECORD',
        );
      }
    }
  });

  it('skips platform money while the tax ruling is open, and a test order always', () => {
    expect(
      creditModeFor({ promotionTestMode: false, orderIsTest: false, gstRulingConfirmed: false }),
    ).toBe('SKIP');
    expect(
      creditModeFor({ promotionTestMode: false, orderIsTest: true, gstRulingConfirmed: true }),
    ).toBe('SKIP');
    expect(
      creditModeFor({ promotionTestMode: false, orderIsTest: false, gstRulingConfirmed: true }),
    ).toBe('REAL');
  });
});

describe('wholeDaysBetween', () => {
  const at = Temporal.Instant.from('2026-10-25T10:00:00Z');
  it('floors to whole days and is negative for a future instant', () => {
    expect(wholeDaysBetween(at.subtract({ hours: 24 * 60 }), at)).toBe(60);
    expect(wholeDaysBetween(at.subtract({ hours: 24 * 60 - 1 }), at)).toBe(59);
    expect(wholeDaysBetween(at, at)).toBe(0);
    expect(wholeDaysBetween(at.add({ hours: 24 }), at)).toBeLessThan(0);
  });
});

describe('creditKey', () => {
  it('is stable per kind and source and within the wallet key alphabet', () => {
    const key = creditKey('REFERRER_REWARD', '01990000-0000-7000-8000-000000000001');
    expect(key).toBe('promotions:referrer-reward:01990000-0000-7000-8000-000000000001');
    expect(key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(creditKey('CASHBACK', 'x')).not.toBe(creditKey('REFEREE_REWARD', 'x'));
  });
});
