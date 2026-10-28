import { money } from '@mondapac/shared-kernel';
import {
  applyDeliveryMargin,
  parseDeliveryPricing,
  ROUNDING_STEPS,
  type DeliveryPricing,
} from './delivery-margin';

// The buyer's price: quote + margin, rounded up. Run on both Market currencies: AUD (cents, 2
// decimals) and JPY (no minor unit), so the steps are tested as minor units and not as cents.

describe.each([['AUD'], ['JPY']] as const)('applyDeliveryMargin in currency %s', (currency) => {
  const of = (amount: number) => money(BigInt(amount), currency);
  const pricing = (
    margin: DeliveryPricing['margin'],
    roundingStepMinor: DeliveryPricing['roundingStepMinor'] = 1,
  ): DeliveryPricing => ({ margin, roundingStepMinor });

  it('charges the quote as it is with no margin and no rounding', () => {
    const priced = applyDeliveryMargin(of(1234), pricing({ kind: 'none' }));
    expect(priced).toEqual({ quote: of(1234), margin: of(0), total: of(1234) });
  });

  it('adds a percent margin, half-up to a minor unit', () => {
    // 10 % of 1234 = 123.4 -> 123
    expect(applyDeliveryMargin(of(1234), pricing({ kind: 'percent', basisPoints: 1000 }))).toEqual({
      quote: of(1234),
      margin: of(123),
      total: of(1357),
    });
    // 12.5 % of 100 = 12.5 -> 13 (half-up)
    expect(
      applyDeliveryMargin(of(100), pricing({ kind: 'percent', basisPoints: 1250 })).margin,
    ).toEqual(of(13));
  });

  it('adds a fixed margin in minor units', () => {
    expect(applyDeliveryMargin(of(1234), pricing({ kind: 'fixed', amountMinor: 150 }))).toEqual({
      quote: of(1234),
      margin: of(150),
      total: of(1384),
    });
  });

  it('rounds the total up to the step and counts the rounding in the margin', () => {
    // 1234 + 10 % = 1357 -> 1360 at step 5 (A$13.57 -> A$13.60)
    const priced = applyDeliveryMargin(
      of(1234),
      pricing({ kind: 'percent', basisPoints: 1000 }, 5),
    );
    expect(priced).toEqual({ quote: of(1234), margin: of(126), total: of(1360) });
  });

  it.each([
    [1, 1357, 1357],
    [5, 1357, 1360],
    [10, 1357, 1360],
    [50, 1357, 1400],
    [100, 1357, 1400],
    [5, 1360, 1360],
    [100, 1400, 1400],
    [100, 1401, 1500],
  ] as const)('step %i takes %i to %i (never rounds down)', (step, amount, expected) => {
    const priced = applyDeliveryMargin(of(amount), pricing({ kind: 'none' }, step));
    expect(priced.total).toEqual(of(expected));
    expect(priced.margin).toEqual(of(expected - amount));
  });

  it('keeps the total equal to the quote plus the margin for every step and kind', () => {
    const margins: DeliveryPricing['margin'][] = [
      { kind: 'none' },
      { kind: 'percent', basisPoints: 777 },
      { kind: 'fixed', amountMinor: 99 },
    ];
    for (const margin of margins) {
      for (const step of ROUNDING_STEPS) {
        for (const quote of [0, 1, 4, 5, 999, 1234, 100000]) {
          const priced = applyDeliveryMargin(of(quote), pricing(margin, step));
          expect(priced.total.amount).toBe(priced.quote.amount + priced.margin.amount);
          expect(priced.total.amount % BigInt(step)).toBe(0n);
          expect(priced.margin.amount >= 0n).toBe(true);
        }
      }
    }
  });

  it('charges a fixed margin on a free quote', () => {
    expect(
      applyDeliveryMargin(of(0), pricing({ kind: 'fixed', amountMinor: 200 }, 50)).total,
    ).toEqual(of(200));
  });

  it('refuses a negative quote', () => {
    expect(() => applyDeliveryMargin(of(-1), pricing({ kind: 'none' }))).toThrow();
  });
});

describe('the worked example of the admin page', () => {
  it('turns a A$12.34 quote into A$13.60 with 10 % and a 5c round-up', () => {
    const priced = applyDeliveryMargin(money(1234n, 'AUD'), {
      margin: { kind: 'percent', basisPoints: 1000 },
      roundingStepMinor: 5,
    });
    expect(priced.total).toEqual(money(1360n, 'AUD'));
  });
});

describe('parseDeliveryPricing', () => {
  const good = { margin: { kind: 'percent', basisPoints: 1000 }, roundingStepMinor: 5 };

  it('accepts the three kinds', () => {
    expect(parseDeliveryPricing(good)).toEqual({
      ok: true,
      value: { margin: { kind: 'percent', basisPoints: 1000 }, roundingStepMinor: 5 },
    });
    expect(
      parseDeliveryPricing({ margin: { kind: 'fixed', amountMinor: 0 }, roundingStepMinor: 1 }).ok,
    ).toBe(true);
    expect(parseDeliveryPricing({ margin: { kind: 'none' }, roundingStepMinor: 100 }).ok).toBe(
      true,
    );
  });

  it.each([
    [{ ...good, roundingStepMinor: 7 }, 'roundingStepMinor'],
    [{ ...good, roundingStepMinor: '5' }, 'roundingStepMinor'],
    [{ ...good, margin: { kind: 'percent', basisPoints: 10001 } }, 'margin.basisPoints'],
    [{ ...good, margin: { kind: 'percent', basisPoints: 1.5 } }, 'margin.basisPoints'],
    [{ ...good, margin: { kind: 'percent', basisPoints: -1 } }, 'margin.basisPoints'],
    [{ ...good, margin: { kind: 'percent', amountMinor: 5 } }, 'margin.amountMinor'],
    [{ ...good, margin: { kind: 'fixed', amountMinor: 1_000_001 } }, 'margin.amountMinor'],
    [{ ...good, margin: { kind: 'fixed', basisPoints: 5 } }, 'margin.basisPoints'],
    [{ ...good, margin: { kind: 'none', amountMinor: 5 } }, 'margin'],
    [{ ...good, margin: { kind: 'bogus' } }, 'margin.kind'],
    [{ ...good, margin: 'none' }, 'margin'],
    [{ ...good, extra: 1 }, 'field'],
  ])('refuses %j at %s', (input, path) => {
    const parsed = parseDeliveryPricing(input);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.fields.map((field) => field.path)).toContain(path);
  });
});
