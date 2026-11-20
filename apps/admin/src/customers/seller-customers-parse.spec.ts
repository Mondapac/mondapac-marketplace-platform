import { describe, expect, it } from 'vitest';

import { parseSellerCustomersSummary } from './seller-customers-types.ts';

const valid = {
  zone: 'Pacific/Auckland',
  counts: { all: 9, buyers: 4, followers: 3, referred: 2 },
  months: [{ month: '2026-10', newBuyers: 1, newFollowers: 2, newExclusive: 1 }],
};

describe('parseSellerCustomersSummary', () => {
  it('reads a valid summary and ignores unknown fields', () => {
    expect(parseSellerCustomersSummary({ ...valid, extra: true })).toEqual(valid);
  });

  it.each([
    ['no zone', { ...valid, zone: undefined }],
    ['a counts key missing', { ...valid, counts: { all: 9, buyers: 4, followers: 3 } }],
    ['a count of the wrong type', { ...valid, counts: { ...valid.counts, referred: '2' } }],
    ['a negative count', { ...valid, counts: { ...valid.counts, all: -1 } }],
    ['a fractional month count', { ...valid, months: [{ ...valid.months[0], newBuyers: 1.5 }] }],
    [
      'a month without newExclusive',
      { ...valid, months: [{ month: '2026-10', newBuyers: 1, newFollowers: 2 }] },
    ],
    ['months not a list', { ...valid, months: {} }],
    ['not an object', null],
  ])('rejects %s', (_label, value) => {
    expect(parseSellerCustomersSummary(value)).toBeNull();
  });
});
