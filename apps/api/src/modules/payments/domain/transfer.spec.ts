import { Temporal } from '@mondapac/shared-kernel';
import {
  INSTRUCTION_KEY,
  isTransferEventType,
  leaseEnd,
  leaseExpired,
  lookupTransfer,
  sameContent,
  type ProviderTransfer,
} from './transfer';

// The pure transfer rules: which key is valid, when a repeated key is the same transfer, the lease
// boundary, and the lookup among a group's transfers (key, destination, amount and currency).

const T0 = Temporal.Instant.from('2026-10-27T10:00:00Z');
const EXPECTED = { key: 'payout-1', accountRef: 'acct_a', amountMinor: 5000n, currency: 'AUD' };
const found = (fields: Partial<ProviderTransfer> = {}): ProviderTransfer => ({
  id: 'tr_1',
  key: 'payout-1',
  destination: 'acct_a',
  amountMinor: 5000n,
  currency: 'aud',
  ...fields,
});

describe('transfer rules', () => {
  it('knows the two transfer event types and no other', () => {
    expect(isTransferEventType('transfer.created')).toBe(true);
    expect(isTransferEventType('transfer.reversed')).toBe(true);
    expect(isTransferEventType('transfer.updated')).toBe(false);
    expect(isTransferEventType('charge.dispute.created')).toBe(false);
  });

  it.each([
    ['payout-1', true],
    ['a:b_c-D9', true],
    ['x'.repeat(128), true],
    ['', false],
    ['x'.repeat(129), false],
    ['has space', false],
    ['semi;colon', false],
    ['new\nline', false],
  ])('checks the instruction key %j', (key, valid) => {
    expect(INSTRUCTION_KEY.test(key)).toBe(valid);
  });

  it('takes a repeated key for the same transfer only when every content field is equal', () => {
    const row = { sellerId: 's1', amountMinor: 5000n, currency: 'AUD', reference: 'r1' };
    const same = { sellerId: 's1', amountMinor: 5000n, currency: 'AUD', reference: 'r1' };
    expect(sameContent(row, same)).toBe(true);
    expect(sameContent(row, { ...same, sellerId: 's2' })).toBe(false);
    expect(sameContent(row, { ...same, amountMinor: 5001n })).toBe(false);
    expect(sameContent(row, { ...same, currency: 'NZD' })).toBe(false);
    expect(sameContent(row, { ...same, reference: 'r2' })).toBe(false);
    // A tombstone has no content at all.
    expect(
      sameContent({ sellerId: null, amountMinor: null, currency: null, reference: null }, same),
    ).toBe(false);
  });

  it('ends a lease at the given seconds and counts the boundary instant as run out', () => {
    const end = leaseEnd(T0, 120);
    expect(end.epochMilliseconds - T0.epochMilliseconds).toBe(120_000);
    expect(leaseExpired(end, end.subtract({ milliseconds: 1 }))).toBe(false);
    expect(leaseExpired(end, end)).toBe(true);
    expect(leaseExpired(end, end.add({ milliseconds: 1 }))).toBe(true);
    // No lease on record is not a lease in force.
    expect(leaseExpired(null, T0)).toBe(true);
  });

  describe('lookupTransfer', () => {
    it('matches on key, destination, amount and currency (case of the currency aside)', () => {
      expect(lookupTransfer([found()], EXPECTED)).toEqual({ kind: 'match', ref: 'tr_1' });
    });

    it('ignores transfers of other keys in the same group', () => {
      expect(lookupTransfer([found({ key: 'payout-2' }), found({ key: null })], EXPECTED)).toEqual({
        kind: 'none',
      });
      expect(lookupTransfer([], EXPECTED)).toEqual({ kind: 'none' });
    });

    it.each([
      ['another destination', { destination: 'acct_b' }],
      ['another amount', { amountMinor: 4999n }],
      ['another currency', { currency: 'nzd' }],
    ])('is a partial match, never "not found", with %s', (_label, change) => {
      expect(lookupTransfer([found(change)], EXPECTED)).toEqual({ kind: 'partial' });
    });

    it('is a partial match when two transfers carry the key, even if both are right', () => {
      expect(lookupTransfer([found(), found({ id: 'tr_2' })], EXPECTED)).toEqual({
        kind: 'partial',
      });
    });
  });
});
