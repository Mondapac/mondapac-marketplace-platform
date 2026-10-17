import { computeLineTax, paramsFromStored, paramsToConfig, parseStrategyDraft } from './strategy';
import type { TaxStrategyParams } from './strategy';

const CODES = ['taxable', 'gst_free'];
const flat = (rateBps: number): TaxStrategyParams => ({ kind: 'flat-rate', rateBps });

describe('computeLineTax', () => {
  it('takes the tax out of an inclusive amount, rounding half up (AU worked examples)', () => {
    // $11.00 -> $1.00; $10.05 -> 0.9136 -> $0.91; $10.10 -> 0.9182 -> $0.92.
    expect(
      computeLineTax({ amount: 1100n, taxInclusive: true, categoryCode: null }, flat(1000)),
    ).toEqual({
      rateBps: 1000,
      tax: 100n,
      net: 1000n,
      gross: 1100n,
    });
    expect(
      computeLineTax({ amount: 1005n, taxInclusive: true, categoryCode: null }, flat(1000)).tax,
    ).toBe(91n);
    expect(
      computeLineTax({ amount: 1010n, taxInclusive: true, categoryCode: null }, flat(1000)).tax,
    ).toBe(92n);
  });

  it('adds the tax on top of an exclusive amount, rounding an exact half up', () => {
    // 10 at 15 % = 1.5 -> 2; 10 at 5 % = 0.5 -> 1 (the half-unit cases of the tax design 4.3).
    expect(
      computeLineTax({ amount: 10n, taxInclusive: false, categoryCode: null }, flat(1500)),
    ).toEqual({
      rateBps: 1500,
      tax: 2n,
      net: 10n,
      gross: 12n,
    });
    expect(
      computeLineTax({ amount: 10n, taxInclusive: false, categoryCode: null }, flat(500)).tax,
    ).toBe(1n);
  });

  it('gives no tax at rate 0 and for a zero amount', () => {
    expect(
      computeLineTax({ amount: 999n, taxInclusive: true, categoryCode: null }, flat(0)),
    ).toEqual({
      rateBps: 0,
      tax: 0n,
      net: 999n,
      gross: 999n,
    });
    expect(
      computeLineTax({ amount: 0n, taxInclusive: false, categoryCode: null }, flat(1000)).tax,
    ).toBe(0n);
  });

  it('keeps net + tax = gross for every amount, with no float drift on large amounts', () => {
    for (const amount of [1n, 7n, 99n, 12_345n, 2n ** 53n - 1n]) {
      for (const inclusive of [true, false]) {
        const line = computeLineTax(
          { amount, taxInclusive: inclusive, categoryCode: null },
          flat(1000),
        );
        expect(line.net + line.tax).toBe(line.gross);
        expect(line.tax >= 0n && line.net >= 0n).toBe(true);
      }
    }
  });

  it('picks the rate of the line category, else the default of a by-category strategy', () => {
    const params: TaxStrategyParams = {
      kind: 'by-category',
      defaultRateBps: 1000,
      categoryRatesBps: { gst_free: 0 },
    };
    const line = (categoryCode: string | null) =>
      computeLineTax({ amount: 1100n, taxInclusive: true, categoryCode }, params);
    expect(line('gst_free')).toMatchObject({ rateBps: 0, tax: 0n });
    expect(line('taxable')).toMatchObject({ rateBps: 1000, tax: 100n });
    expect(line(null)).toMatchObject({ rateBps: 1000, tax: 100n });
  });
});

describe('parseStrategyDraft', () => {
  it('builds a flat-rate and a by-category strategy and trims the name', () => {
    expect(parseStrategyDraft({ name: ' GST ', kind: 'flat-rate', rateBps: 1000 }, CODES)).toEqual({
      ok: true,
      value: { name: 'GST', params: flat(1000) },
    });
    expect(
      parseStrategyDraft(
        {
          name: 'By category',
          kind: 'by-category',
          defaultRateBps: 1000,
          categoryRatesBps: { gst_free: 0 },
        },
        CODES,
      ),
    ).toEqual({
      ok: true,
      value: {
        name: 'By category',
        params: { kind: 'by-category', defaultRateBps: 1000, categoryRatesBps: { gst_free: 0 } },
      },
    });
  });

  it.each([
    [{ name: '', kind: 'flat-rate', rateBps: 1000 }, 'name'],
    [{ name: 'x'.repeat(81), kind: 'flat-rate', rateBps: 1000 }, 'name'],
    [{ name: 'x', kind: 'flat-rate', rateBps: 5001 }, 'rateBps'],
    [{ name: 'x', kind: 'flat-rate', rateBps: -1 }, 'rateBps'],
    [{ name: 'x', kind: 'flat-rate', rateBps: 10.5 }, 'rateBps'],
    [{ name: 'x', kind: 'flat-rate', rateBps: '1000' }, 'rateBps'],
    [{ name: 'x', kind: 'compound', rateBps: 1000 }, 'kind'],
    [
      { name: 'x', kind: 'by-category', defaultRateBps: 1000, categoryRatesBps: { alcohol: 0 } },
      'categoryRatesBps.alcohol',
    ],
    [
      { name: 'x', kind: 'by-category', defaultRateBps: 1000, categoryRatesBps: { taxable: 9999 } },
      'categoryRatesBps.taxable',
    ],
    [
      { name: 'x', kind: 'by-category', defaultRateBps: 1000, categoryRatesBps: [] },
      'categoryRatesBps',
    ],
    [{ name: 'x', kind: 'by-category', categoryRatesBps: {} }, 'defaultRateBps'],
  ])('refuses %j at %s', (input, path) => {
    const result = parseStrategyDraft(input, CODES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.map((issue) => issue.path)).toContain(path);
  });

  it('refuses a non-object body', () => {
    expect(parseStrategyDraft(null, CODES).ok).toBe(false);
    expect(parseStrategyDraft('x', CODES).ok).toBe(false);
  });
});

describe('stored strategies', () => {
  it('round-trips through the config column', () => {
    const by: TaxStrategyParams = {
      kind: 'by-category',
      defaultRateBps: 1000,
      categoryRatesBps: { gst_free: 0 },
    };
    expect(paramsFromStored('flat-rate', paramsToConfig(flat(1000)))).toEqual(flat(1000));
    expect(paramsFromStored('by-category', paramsToConfig(by))).toEqual(by);
  });

  it('rejects a damaged row instead of guessing', () => {
    expect(paramsFromStored('flat-rate', { rateBps: 'x' })).toBeNull();
    expect(paramsFromStored('flat-rate', null)).toBeNull();
    expect(
      paramsFromStored('by-category', { defaultRateBps: 1000, categoryRatesBps: { a: 99999 } }),
    ).toBeNull();
    expect(paramsFromStored('mystery', { rateBps: 1 })).toBeNull();
  });
});
