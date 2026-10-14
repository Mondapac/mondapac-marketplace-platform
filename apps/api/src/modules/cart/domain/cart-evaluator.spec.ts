import { money } from '@mondapac/shared-kernel';
import { evaluateMinimumOrder, type BuyableLine } from './cart-evaluator';

// The minimum-order rule of cart design 6.4 on both Market fixtures: AU (AUD, GST-inclusive, 2
// decimals) and the synthetic ZZ (JPY, tax-exclusive, no decimals).

describe.each([
  ['AU', 'AUD', true],
  ['ZZ', 'JPY', false],
] as const)('evaluateMinimumOrder in %s', (_code, currency, taxInclusive) => {
  const line = (amount: bigint, quantity = 1, tax: boolean | null = taxInclusive): BuyableLine => ({
    unitPrice: money(amount, currency),
    quantity,
    taxInclusive: tax,
  });
  const minimum = (amount: bigint) =>
    ({ kind: 'minimum', minimum: money(amount, currency) }) as const;

  it('is not applicable without a buyable line, whatever sellers said', () => {
    expect(evaluateMinimumOrder([], minimum(5000n))).toEqual({
      state: 'not-applicable',
      minimum: null,
      subtotal: null,
    });
    expect(evaluateMinimumOrder([], undefined).state).toBe('not-applicable');
  });

  it('treats an explicit none as any amount', () => {
    expect(evaluateMinimumOrder([line(100n)], { kind: 'none' })).toEqual({
      state: 'none',
      minimum: null,
      subtotal: money(100n, currency),
    });
  });

  it('is below the minimum by one minor unit, and met at the minimum and above', () => {
    expect(evaluateMinimumOrder([line(2499n)], minimum(2500n))).toEqual({
      state: 'below-minimum',
      minimum: money(2500n, currency),
      subtotal: money(2499n, currency),
    });
    expect(evaluateMinimumOrder([line(2500n)], minimum(2500n)).state).toBe('met');
    expect(evaluateMinimumOrder([line(2501n)], minimum(2500n)).state).toBe('met');
  });

  it('sums price times quantity over all buyable lines', () => {
    const result = evaluateMinimumOrder([line(1000n, 2), line(250n, 4)], minimum(3000n));

    expect(result).toEqual({
      state: 'met',
      minimum: money(3000n, currency),
      subtotal: money(3000n, currency),
    });
  });

  it('never reads an unknown minimum as none', () => {
    for (const unknown of [undefined, { kind: 'unknown' } as const]) {
      expect(evaluateMinimumOrder([line(9999n)], unknown)).toEqual({
        state: 'check-unavailable',
        minimum: null,
        subtotal: money(9999n, currency),
      });
    }
  });

  it('fails closed on a minimum in another currency, or one that is not above zero', () => {
    const other = currency === 'AUD' ? 'JPY' : 'AUD';
    expect(
      evaluateMinimumOrder([line(100n)], { kind: 'minimum', minimum: money(50n, other) }).state,
    ).toBe('check-unavailable');
    expect(evaluateMinimumOrder([line(100n)], minimum(0n)).state).toBe('check-unavailable');
  });

  it('fails closed when the lines mix tax conventions or currencies', () => {
    expect(
      evaluateMinimumOrder([line(100n), line(100n, 1, !taxInclusive)], minimum(50n)).state,
    ).toBe('check-unavailable');
    expect(evaluateMinimumOrder([line(100n, 1, null)], minimum(50n)).state).toBe(
      'check-unavailable',
    );
    const mixed: BuyableLine = {
      unitPrice: money(100n, currency === 'AUD' ? 'JPY' : 'AUD'),
      quantity: 1,
      taxInclusive,
    };
    expect(evaluateMinimumOrder([line(100n), mixed], { kind: 'none' }).state).toBe(
      'check-unavailable',
    );
  });
});
