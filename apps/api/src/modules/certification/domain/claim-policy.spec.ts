import type { Id } from '@mondapac/shared-kernel';
import {
  MAX_POLICY_ROWS,
  policyRevisionDiff,
  policyRowsIn,
  relaxesPolicy,
  selectorKey,
  type PolicyRow,
} from './claim-policy';

const CAT_A = '0197f2a0-0000-7000-8000-0000000000a1';
const CAT_B = '0197f2a0-0000-7000-8000-0000000000b2';
const cat = (categoryId: string, basis: PolicyRow['basis']): PolicyRow => ({
  selector: { kind: 'platform-category', categoryId: categoryId as Id<'Category'> },
  basis,
});
const handling = (value: 'SEALED_ORIGINAL' | 'REPACKED', basis: PolicyRow['basis']): PolicyRow => ({
  selector: { kind: 'handling', handling: value },
  basis,
});

describe('policyRowsIn (design 2.1, 3.7; M1)', () => {
  it('parses category and handling rows into a canonical order', () => {
    const parsed = policyRowsIn([
      { selector: 'handling', handling: 'REPACKED', basis: 'SELLER_REQUIRED' },
      { selector: 'platform-category', categoryId: CAT_B, basis: 'NOT_APPLICABLE' },
      { selector: 'platform-category', categoryId: CAT_A, basis: 'SELLER_OR_MANUFACTURER' },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.map((row) => selectorKey(row.selector))).toEqual([
      CAT_A,
      CAT_B,
      'REPACKED',
    ]);
  });

  it('accepts an empty row set (every query gets the type default)', () => {
    expect(policyRowsIn([])).toEqual({ ok: true, value: [] });
  });

  it('refuses SELLER_OR_MANUFACTURER on every handling selector (M1)', () => {
    for (const value of ['SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH']) {
      const parsed = policyRowsIn([
        { selector: 'handling', handling: value, basis: 'SELLER_OR_MANUFACTURER' },
      ]);
      expect(parsed).toEqual({
        ok: false,
        error: [{ path: 'rows[0].basis', code: 'manufacturer-basis-on-handling' }],
      });
    }
  });

  it('refuses two rows on one selector', () => {
    const parsed = policyRowsIn([
      { selector: 'platform-category', categoryId: CAT_A, basis: 'SELLER_REQUIRED' },
      { selector: 'platform-category', categoryId: CAT_A, basis: 'NOT_APPLICABLE' },
      { selector: 'handling', handling: 'FRESH', basis: 'SELLER_REQUIRED' },
      { selector: 'handling', handling: 'FRESH', basis: 'NOT_APPLICABLE' },
    ]);
    expect(parsed).toEqual({
      ok: false,
      error: [
        { path: 'rows[1]', code: 'duplicate-selector' },
        { path: 'rows[3]', code: 'duplicate-selector' },
      ],
    });
  });

  it('refuses unknown values, unknown fields, wrong shapes and too many rows', () => {
    const bad: [unknown, string, string][] = [
      ['rows', 'rows', 'type'],
      [[null], 'rows[0]', 'type'],
      [[{ selector: 'brand', basis: 'SELLER_REQUIRED' }], 'rows[0].selector', 'format'],
      [
        [{ selector: 'handling', handling: 'FROZEN', basis: 'SELLER_REQUIRED' }],
        'rows[0].handling',
        'format',
      ],
      [
        [{ selector: 'platform-category', categoryId: 'nope', basis: 'SELLER_REQUIRED' }],
        'rows[0].categoryId',
        'format',
      ],
      [
        [{ selector: 'platform-category', categoryId: CAT_A, basis: 'SELLER' }],
        'rows[0].basis',
        'format',
      ],
      [
        [{ selector: 'platform-category', categoryId: CAT_A, basis: 'toString' }],
        'rows[0].basis',
        'format',
      ],
      [
        [
          {
            selector: 'platform-category',
            categoryId: CAT_A,
            handling: 'FRESH',
            basis: 'SELLER_REQUIRED',
          },
        ],
        'rows[0].handling',
        'unknown-field',
      ],
      [
        [{ selector: 'platform-category', categoryId: CAT_A, basis: 'SELLER_REQUIRED', x: 1 }],
        'rows[0].x',
        'unknown-field',
      ],
      [Array.from({ length: MAX_POLICY_ROWS + 1 }, () => ({})), 'rows', 'length'],
    ];
    for (const [raw, path, code] of bad) {
      const parsed = policyRowsIn(raw);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error[0]).toEqual({ path, code });
    }
  });
});

describe('policyRevisionDiff and relaxesPolicy (design 3.7; Hassan C1; H1)', () => {
  it('finds no change between equal row sets', () => {
    const rows = [cat(CAT_A, 'SELLER_REQUIRED'), handling('REPACKED', 'NOT_APPLICABLE')];
    expect(policyRevisionDiff(rows, [...rows].reverse(), 'SELLER_REQUIRED')).toEqual([]);
  });

  it('a stricter change, a removed SELLER_OR_MANUFACTURER row and an added stricter row only tighten', () => {
    const before = [cat(CAT_A, 'SELLER_OR_MANUFACTURER'), cat(CAT_B, 'SELLER_REQUIRED')];
    const after = [cat(CAT_B, 'NOT_APPLICABLE'), handling('REPACKED', 'NOT_APPLICABLE')];
    const diff = policyRevisionDiff(before, after, 'SELLER_REQUIRED');
    expect(diff).toEqual([
      { path: `row:${CAT_A}`, before: 'SELLER_OR_MANUFACTURER', after: null, relaxes: false },
      { path: `row:${CAT_B}`, before: 'SELLER_REQUIRED', after: 'NOT_APPLICABLE', relaxes: false },
      { path: 'row:REPACKED', before: null, after: 'NOT_APPLICABLE', relaxes: false },
    ]);
    expect(relaxesPolicy(diff)).toBe(false);
  });

  it('an added row as strict as the default does not relax', () => {
    const diff = policyRevisionDiff([], [cat(CAT_A, 'SELLER_REQUIRED')], 'SELLER_REQUIRED');
    expect(relaxesPolicy(diff)).toBe(false);
  });

  it('relaxes: a basis made less strict', () => {
    const diff = policyRevisionDiff(
      [cat(CAT_A, 'NOT_APPLICABLE')],
      [cat(CAT_A, 'SELLER_REQUIRED')],
      'SELLER_REQUIRED',
    );
    expect(diff).toEqual([
      { path: `row:${CAT_A}`, before: 'NOT_APPLICABLE', after: 'SELLER_REQUIRED', relaxes: true },
    ]);
    expect(relaxesPolicy(diff)).toBe(true);
  });

  it('relaxes: a removed row that is not SELLER_OR_MANUFACTURER', () => {
    for (const basis of ['SELLER_REQUIRED', 'NOT_APPLICABLE'] as const) {
      const diff = policyRevisionDiff([cat(CAT_A, basis)], [], 'NOT_APPLICABLE');
      expect(relaxesPolicy(diff)).toBe(true);
    }
  });

  it('relaxes: an added row less strict than the type default, on AU and ZZ defaults (Hassan C1)', () => {
    // AU-like default SELLER_REQUIRED: a new SELLER_OR_MANUFACTURER row relaxes.
    expect(
      relaxesPolicy(
        policyRevisionDiff([], [cat(CAT_A, 'SELLER_OR_MANUFACTURER')], 'SELLER_REQUIRED'),
      ),
    ).toBe(true);
    // ZZ-like default NOT_APPLICABLE: a new SELLER_REQUIRED row relaxes as well.
    expect(
      relaxesPolicy(policyRevisionDiff([], [cat(CAT_A, 'SELLER_REQUIRED')], 'NOT_APPLICABLE')),
    ).toBe(true);
    expect(
      relaxesPolicy(
        policyRevisionDiff([], [handling('REPACKED', 'NOT_APPLICABLE')], 'NOT_APPLICABLE'),
      ),
    ).toBe(false);
  });

  it('reads an unknown type default as the strictest, so any added easier row needs a second admin', () => {
    expect(
      relaxesPolicy(policyRevisionDiff([], [cat(CAT_A, 'SELLER_REQUIRED')], 'BOGUS' as never)),
    ).toBe(true);
  });
});
