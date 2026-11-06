import { describe, expect, it } from 'vitest';
import {
  fallbackSku,
  isLastSelling,
  isValidSku,
  unitPlanOf,
  type UnitRow,
} from './sell-unit-logic.ts';
import type { SellUnitView } from './types.ts';

const unit = (n: number, over: Partial<SellUnitView> = {}): UnitRow => ({
  variantId: `v${n}`,
  unit: {
    variantId: `v${n}`,
    variantNo: n,
    variantCode: `MP-000001-0${n}`,
    state: 'published',
    label: null,
    selling: true,
    variantSku: null,
    ...over,
  },
});
const ROWS = [unit(1), unit(2, { variantSku: 'OLD-2' }), unit(3, { selling: false })];

describe('fallbackSku', () => {
  it('pads the variant number like the variant code', () => {
    expect(fallbackSku('ABC', 2)).toBe('ABC-02');
    expect(fallbackSku('ABC', 12)).toBe('ABC-12');
    expect(fallbackSku('ABC', 100)).toBe('ABC-100');
  });
});

describe('isValidSku', () => {
  it('takes 1 to 64 printable ASCII characters without a space', () => {
    expect(isValidSku('A')).toBe(true);
    expect(isValidSku('a-b_c.1/2#')).toBe(true);
    expect(isValidSku('x'.repeat(64))).toBe(true);
    expect(isValidSku('x'.repeat(65))).toBe(false);
    expect(isValidSku('')).toBe(false);
    expect(isValidSku('a b')).toBe(false);
    expect(isValidSku('café')).toBe(false);
    expect(isValidSku('a\tb')).toBe(false);
  });
});

describe('unitPlanOf', () => {
  it('sends nothing when nothing changed', () => {
    expect(unitPlanOf(ROWS, {}, {})).toEqual({
      changes: [],
      badSku: [],
      duplicateSku: [],
      noneSelling: false,
    });
  });

  it('sends nothing for a draft equal to what was saved, even with other spacing', () => {
    const plan = unitPlanOf(ROWS, { v1: '  ', v2: ' OLD-2 ' }, { v1: true, v3: false });
    expect(plan.changes).toEqual([]);
  });

  it('trims a SKU and sends only the changed units, only the changed field', () => {
    const plan = unitPlanOf(ROWS, { v1: '  NEW-1  ' }, { v3: true });
    expect(plan.changes).toEqual([
      { variantId: 'v1', variantSku: 'NEW-1' },
      { variantId: 'v3', selling: true },
    ]);
  });

  it('clears a SKU with an empty text', () => {
    expect(unitPlanOf(ROWS, { v2: '   ' }, {}).changes).toEqual([
      { variantId: 'v2', variantSku: null },
    ]);
  });

  it('flags a SKU that is not 1 to 64 printable characters without a space, and does not send it', () => {
    const plan = unitPlanOf(ROWS, { v1: 'a b', v2: 'x'.repeat(65) }, {});
    expect(plan.badSku).toEqual(['v1', 'v2']);
    expect(plan.changes).toEqual([]);
  });

  it('flags the same SKU typed on two rows', () => {
    const plan = unitPlanOf(ROWS, { v1: 'SAME', v3: 'SAME' }, {});
    expect(plan.duplicateSku.sort()).toEqual(['v1', 'v3']);
    // a typed SKU equal to an unchanged saved one of another row is a duplicate too
    expect(unitPlanOf(ROWS, { v1: 'OLD-2' }, {}).duplicateSku.sort()).toEqual(['v1', 'v2']);
  });

  it('does not call two untouched equal rows a duplicate', () => {
    const rows = [unit(1, { variantSku: 'S' }), unit(2, { variantSku: 'S' })];
    expect(unitPlanOf(rows, {}, {}).duplicateSku).toEqual([]);
  });

  it('flags a draft that leaves no unit selling', () => {
    const plan = unitPlanOf(ROWS, {}, { v1: false, v2: false });
    expect(plan.noneSelling).toBe(true);
    expect(unitPlanOf(ROWS, {}, { v1: false }).noneSelling).toBe(false);
    expect(unitPlanOf(ROWS, {}, { v1: false, v3: true }).noneSelling).toBe(false);
  });
});

describe('isLastSelling', () => {
  it('is true for the only unit still on sale', () => {
    expect(isLastSelling(ROWS, { v1: false }, 'v2')).toBe(true);
    expect(isLastSelling(ROWS, {}, 'v1')).toBe(false);
    expect(isLastSelling(ROWS, { v3: true }, 'v1')).toBe(false);
    expect(isLastSelling(ROWS, { v1: false }, 'v3')).toBe(false);
  });
});
