import { money } from '@mondapac/shared-kernel';
import { parseFleetFeeReport } from './fleet-fee';

const ORDER = '0198a000-0000-7000-8000-000000000001';
const valid = {
  fleet: 'uber_direct',
  sellerOrderId: ORDER,
  reason: 'cancel',
  amount: '350',
  externalRef: 'fee-123',
  occurredAt: '2026-10-26T01:00:00Z',
};

describe.each([['AUD'], ['JPY']] as const)('parseFleetFeeReport in %s', (currency) => {
  it('reads a fee in the Market currency', () => {
    const parsed = parseFleetFeeReport(valid, currency);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      fleet: 'uber_direct',
      sellerOrderId: ORDER,
      reason: 'cancel',
      amount: money(350n, currency),
      externalRef: 'fee-123',
    });
    expect(parsed.value.occurredAt.toString()).toBe('2026-10-26T01:00:00Z');
  });

  it('takes a bigint amount and every reason code', () => {
    for (const reason of ['cancel', 'waiting', 'return', 'other']) {
      expect(parseFleetFeeReport({ ...valid, reason, amount: 1n }, currency).ok).toBe(true);
    }
  });

  it.each([
    ['an unknown fleet', { fleet: 'bike' }, 'fleet'],
    ['a malformed seller order id', { sellerOrderId: 'x' }, 'sellerOrderId'],
    ['an unknown reason', { reason: 'tip' }, 'reason'],
    ['a zero amount', { amount: '0' }, 'amount'],
    ['a negative amount', { amount: '-5' }, 'amount'],
    ['a fractional amount', { amount: '3.5' }, 'amount'],
    ['an empty reference', { externalRef: '' }, 'externalRef'],
    ['an overlong reference', { externalRef: 'x'.repeat(121) }, 'externalRef'],
    ['a malformed instant', { occurredAt: 'yesterday' }, 'occurredAt'],
  ])('refuses %s', (_name, patch, path) => {
    const parsed = parseFleetFeeReport({ ...valid, ...patch }, currency);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.map((field) => field.path)).toEqual([path]);
  });

  it('names every problem of an empty report', () => {
    const parsed = parseFleetFeeReport(null, currency);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.map((field) => field.path).sort()).toEqual(
        ['amount', 'externalRef', 'fleet', 'occurredAt', 'reason', 'sellerOrderId'].sort(),
      );
    }
  });
});
