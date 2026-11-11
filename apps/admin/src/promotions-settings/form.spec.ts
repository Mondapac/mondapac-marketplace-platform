import { describe, expect, it } from 'vitest';
import {
  bpsOf,
  checkFirstOrder,
  decimalOf,
  firstOrderChanges,
  firstOrderDraftOf,
  percentOf,
  zoneChanges,
  zoneDraftsOf,
} from './form.ts';
import type { FirstOrderSettings, Thresholds } from './types.ts';

const saved: FirstOrderSettings = {
  enabled: true,
  kind: 'FIXED',
  percentBps: null,
  amountMinor: '800',
  capMinor: null,
  minSpendMinor: '3000',
  monthlyBudgetMinor: '100000',
};

describe('percentages', () => {
  it('turn into basis points with at most two decimals', () => {
    expect(bpsOf('10')).toBe(1000);
    expect(bpsOf('12.5')).toBe(1250);
    expect(bpsOf('0.01')).toBe(1);
    expect(bpsOf('100')).toBe(10000);
  });
  it('refuse zero, above 100, three decimals and words', () => {
    for (const text of ['0', '100.01', '1.234', 'ten', '', '-5']) expect(bpsOf(text)).toBeNull();
  });
  it('read back the way they were typed', () => {
    expect(percentOf(1000)).toBe('10');
    expect(percentOf(1250)).toBe('12.5');
    expect(percentOf(1)).toBe('0.01');
    expect(percentOf(null)).toBe('');
  });
});

describe('first-order draft', () => {
  it('shows saved minor units as decimals', () => {
    expect(decimalOf('800', 'AUD')).toBe('8.00');
    expect(decimalOf('5', 'AUD')).toBe('0.05');
    expect(decimalOf('800', 'JPY')).toBe('800');
    expect(firstOrderDraftOf(saved, 'AUD')).toMatchObject({
      amount: '8.00',
      minSpend: '30.00',
      budget: '1000.00',
      cap: '',
    });
  });

  it('sends a fixed amount without a percentage or a cap', () => {
    const result = checkFirstOrder(firstOrderDraftOf(saved, 'AUD'), 'AUD');
    expect(result).toEqual({
      ok: true,
      body: {
        enabled: true,
        kind: 'FIXED',
        amountMinor: '800',
        minSpendMinor: '3000',
        monthlyBudgetMinor: '100000',
      },
    });
  });

  it('sends a percentage with its optional cap, and accepts zero minimum spend and budget', () => {
    const draft = {
      ...firstOrderDraftOf(saved, 'AUD'),
      kind: 'PERCENT' as const,
      percent: '12.5',
      cap: '20',
      minSpend: '0',
      budget: '0.00',
    };
    expect(checkFirstOrder(draft, 'AUD')).toEqual({
      ok: true,
      body: {
        enabled: true,
        kind: 'PERCENT',
        percentBps: 1250,
        capMinor: '2000',
        minSpendMinor: '0',
        monthlyBudgetMinor: '0',
      },
    });
  });

  it('names every field that fails', () => {
    const draft = {
      ...firstOrderDraftOf(saved, 'AUD'),
      amount: '0',
      minSpend: 'a lot',
      budget: '',
    };
    expect(checkFirstOrder(draft, 'AUD')).toEqual({
      ok: false,
      invalid: ['amount', 'minSpend', 'budget'],
    });
    const percent = { ...draft, kind: 'PERCENT' as const, percent: '', cap: '0' };
    expect(checkFirstOrder(percent, 'AUD')).toMatchObject({
      ok: false,
      invalid: ['percent', 'cap', 'minSpend', 'budget'],
    });
  });

  it('lists only the fields of the chosen kind that changed', () => {
    const base = firstOrderDraftOf(saved, 'AUD');
    expect(firstOrderChanges(saved, base, 'AUD')).toEqual([]);
    expect(firstOrderChanges(saved, { ...base, amount: '9.00', budget: '2000' }, 'AUD')).toEqual([
      'amount',
      'budget',
    ]);
    // A cap typed while the kind is fixed is not part of the discount.
    expect(firstOrderChanges(saved, { ...base, cap: '5' }, 'AUD')).toEqual([]);
    expect(firstOrderChanges(null, { ...base, enabled: true }, 'AUD')).toContain('enabled');
  });
});

describe('zone thresholds', () => {
  const thresholds: Thresholds = {
    currency: 'AUD',
    defaultThresholdMinor: '5000',
    zones: [{ zoneCode: 'logan', thresholdMinor: '6000' }],
  };

  it('start unchanged', () => {
    expect(zoneChanges(thresholds, zoneDraftsOf(thresholds))).toEqual([]);
  });

  it('write a changed amount, a new zone and a return to the default', () => {
    const drafts = [
      { zoneCode: 'logan', own: true, value: '65.50' },
      { zoneCode: 'gold-coast', own: true, value: '75' },
    ];
    expect(zoneChanges(thresholds, drafts)).toEqual([
      { zoneCode: 'logan', thresholdMinor: '6550' },
      { zoneCode: 'gold-coast', thresholdMinor: '7500' },
    ]);
    expect(zoneChanges(thresholds, [{ zoneCode: 'logan', own: false, value: '' }])).toEqual([
      { zoneCode: 'logan', thresholdMinor: null },
    ]);
  });

  it('writes nothing for a new zone left on the default, and flags a bad amount', () => {
    expect(zoneChanges(thresholds, [{ zoneCode: 'x', own: false, value: '' }])).toEqual([]);
    expect(zoneChanges(thresholds, [{ zoneCode: 'logan', own: true, value: '0' }])).toEqual([
      { zoneCode: 'logan', invalid: true },
    ]);
  });
});

describe('other currencies', () => {
  const yen: FirstOrderSettings = { ...saved, amountMinor: '800', minSpendMinor: '3000' };
  it('scale by the currency: no decimals for JPY, three for KWD', () => {
    expect(decimalOf('800', 'JPY')).toBe('800');
    expect(decimalOf('8000', 'KWD')).toBe('8.000');
    expect(checkFirstOrder(firstOrderDraftOf(yen, 'JPY'), 'JPY')).toMatchObject({
      ok: true,
      body: { amountMinor: '800', minSpendMinor: '3000' },
    });
    const draft = { ...firstOrderDraftOf(yen, 'JPY'), amount: '8.5' };
    expect(checkFirstOrder(draft, 'JPY')).toMatchObject({ ok: false, invalid: ['amount'] });
    const kwd = { ...firstOrderDraftOf(yen, 'KWD'), amount: '1.250' };
    expect(checkFirstOrder(kwd, 'KWD')).toMatchObject({ ok: true, body: { amountMinor: '1250' } });
  });
  it('fail closed on an unknown currency', () => {
    expect(checkFirstOrder(firstOrderDraftOf(yen, 'AUD'), '')).toMatchObject({ ok: false });
    expect(
      zoneChanges({ currency: '', defaultThresholdMinor: '5000', zones: [] }, [
        { zoneCode: 'x', own: true, value: '5' },
      ]),
    ).toEqual([{ zoneCode: 'x', invalid: true }]);
  });
});
