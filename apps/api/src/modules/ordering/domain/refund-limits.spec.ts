import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  checkRefundLimit,
  limitInForce,
  parseRefundLimitInput,
  type RefundLimit,
} from './refund-limits';

const id = <T extends string>(n: number) => {
  const parsed = parseId<T>(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
] as const)('the caps on seller refunds in market %s', (_code, currency) => {
  const cap = (
    sellerId: Id<'Seller'> | null,
    maxCount: number,
    maxAmount: bigint,
  ): RefundLimit => ({
    id: id<'SellerRefundLimit'>(sellerId === null ? 1 : 2),
    sellerId,
    maxCount,
    maxAmount: money(maxAmount, currency),
    version: 1,
    updatedAt: Temporal.Instant.from('2026-11-11T05:00:00Z'),
    updatedBy: id<'Account'>(3),
  });
  const refund = (gross: bigint) => ({ gross, currency });

  it("uses the seller's own cap over the Market default, and none without either", () => {
    const own = cap(id<'Seller'>(9), 1, 100n);
    const marketDefault = cap(null, 10, 1000n);
    expect(limitInForce(own, marketDefault)).toBe(own);
    expect(limitInForce(null, marketDefault)).toBe(marketDefault);
    expect(limitInForce(null, null)).toBeNull();
  });

  it('lets a refund through up to both caps, and names the cap it would pass', () => {
    const limit = cap(null, 3, 1000n);
    expect(checkRefundLimit(limit, { count: 2, amount: 500n }, refund(500n))).toBe('within');
    expect(checkRefundLimit(limit, { count: 3, amount: 0n }, refund(1n))).toBe('count');
    expect(checkRefundLimit(limit, { count: 0, amount: 600n }, refund(401n))).toBe('amount');
    // The count is checked first when both would pass.
    expect(checkRefundLimit(limit, { count: 3, amount: 1000n }, refund(1n))).toBe('count');
  });

  it('refuses without a cap, or with a cap in another currency (fail closed)', () => {
    expect(checkRefundLimit(null, { count: 0, amount: 0n }, refund(1n))).toBe('unset');
    const other = { ...cap(null, 10, 1000n), maxAmount: money(1000n, 'EUR') };
    expect(checkRefundLimit(other, { count: 0, amount: 0n }, refund(1n))).toBe('unset');
  });

  it('reads an admin’s cap: 1 to 1000 refunds, a positive amount as digits, a version', () => {
    expect(parseRefundLimitInput({ maxCount: 20, maxAmount: '50000', expectedVersion: 0 })).toEqual(
      { ok: true, value: { maxCount: 20, maxAmount: 50000n, expectedVersion: 0 } },
    );
    expect(parseRefundLimitInput({ maxCount: 1001, maxAmount: '0', expectedVersion: 1.5 })).toEqual(
      {
        ok: false,
        fields: [
          { path: 'maxCount', code: 'range' },
          { path: 'maxAmount', code: 'range' },
          { path: 'expectedVersion', code: 'range' },
        ],
      },
    );
    expect(parseRefundLimitInput({ maxCount: '5', maxAmount: 500, expectedVersion: -1 })).toEqual({
      ok: false,
      fields: [
        { path: 'maxCount', code: 'range' },
        { path: 'maxAmount', code: 'format' },
        { path: 'expectedVersion', code: 'range' },
      ],
    });
  });
});
