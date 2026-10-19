import { reverseRefundTax } from './reverse-flow';

// The tax a refund reverses, from frozen values only: the same answer for both Market fixtures,
// since nothing here reads a rate, a strategy or the clock.

describe('reverseRefundTax', () => {
  it('answers the unit shares of each line and the cumulative share of each charge', () => {
    expect(
      reverseRefundTax({
        lines: [{ tax: 100n, quantity: 3, unitsBefore: 0, units: 1 }],
        charges: [{ tax: 50n, gross: 550n, before: 0n, after: 275n }],
      }),
    ).toEqual({ ok: true, value: { lines: [34n], charges: [25n] } });
  });

  it('refuses the whole call on one bad value', () => {
    for (const input of [
      { lines: [{ tax: 100n, quantity: 3, unitsBefore: 2, units: 2 }], charges: [] },
      { lines: [{ tax: -1n, quantity: 3, unitsBefore: 0, units: 1 }], charges: [] },
      { lines: [{ tax: 1n, quantity: 3, unitsBefore: 0, units: 0 }], charges: [] },
      { lines: [], charges: [{ tax: 50n, gross: 550n, before: 300n, after: 200n }] },
      { lines: [], charges: [{ tax: 50n, gross: 550n, before: 0n, after: 600n }] },
      { lines: [], charges: [{ tax: 600n, gross: 550n, before: 0n, after: 1n }] },
      { lines: 'all', charges: [] },
      { lines: [], charges: new Array(11).fill({ tax: 0n, gross: 0n, before: 0n, after: 0n }) },
    ]) {
      const answer = reverseRefundTax(input);
      expect(answer.ok ? 'ok' : answer.error.code).toBe('validation.failed');
    }
  });
});
