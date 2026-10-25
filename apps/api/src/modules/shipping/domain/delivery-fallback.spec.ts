import { money } from '@mondapac/shared-kernel';
import { assessFallback } from './delivery-fallback';

// The cap is in minor units of the Market currency (AU default 1000 = A$10.00). Both fixtures'
// currencies: AUD has cents, JPY has none, so the same number of minor units is a different amount.

describe.each([['AUD'], ['JPY']] as const)('assessFallback in %s', (currency) => {
  const of = (amount: number) => money(BigInt(amount), currency);
  const CAP = 1000;

  it('absorbs a difference below the cap without an alert', () => {
    expect(
      assessFallback({ chargedQuote: of(1200), bookedPrice: of(1900), capMinor: CAP }),
    ).toEqual({
      kind: 'known',
      difference: of(700),
      overCap: false,
    });
  });

  it('keeps a difference of exactly the cap within it', () => {
    const answer = assessFallback({ chargedQuote: of(1200), bookedPrice: of(2200), capMinor: CAP });
    expect(answer).toEqual({ kind: 'known', difference: of(1000), overCap: false });
  });

  it('alerts when the difference is one minor unit above the cap', () => {
    const answer = assessFallback({ chargedQuote: of(1200), bookedPrice: of(2201), capMinor: CAP });
    expect(answer).toEqual({ kind: 'known', difference: of(1001), overCap: true });
  });

  it('costs nothing extra when the booked fleet is cheaper or the same', () => {
    expect(assessFallback({ chargedQuote: of(1200), bookedPrice: of(900), capMinor: CAP })).toEqual(
      {
        kind: 'known',
        difference: of(0),
        overCap: false,
      },
    );
    expect(
      assessFallback({ chargedQuote: of(1200), bookedPrice: of(1200), capMinor: CAP }),
    ).toEqual({
      kind: 'known',
      difference: of(0),
      overCap: false,
    });
  });

  it('with a cap of zero, any difference alerts and none does not', () => {
    expect(
      assessFallback({ chargedQuote: of(1200), bookedPrice: of(1201), capMinor: 0 }).overCap,
    ).toBe(true);
    expect(
      assessFallback({ chargedQuote: of(1200), bookedPrice: of(1200), capMinor: 0 }).overCap,
    ).toBe(false);
  });

  it('alerts when the booked fleet price is unknown or in another currency', () => {
    expect(assessFallback({ chargedQuote: of(1200), bookedPrice: null, capMinor: CAP })).toEqual({
      kind: 'cost-unknown',
      overCap: true,
    });
    const other = money(1n, currency === 'AUD' ? 'JPY' : 'AUD');
    expect(assessFallback({ chargedQuote: of(1200), bookedPrice: other, capMinor: CAP })).toEqual({
      kind: 'cost-unknown',
      overCap: true,
    });
  });
});
