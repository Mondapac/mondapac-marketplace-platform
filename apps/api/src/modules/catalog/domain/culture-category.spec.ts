import type { Id } from '@mondapac/shared-kernel';
import {
  parseCategoryMark,
  resolveEffectiveMarks,
  resolveTreeMarks,
  type CultureCategoryRow,
} from './culture-category';

const c = (n: number) =>
  `01990000-0000-7000-8000-${(0xc00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;
const row = (
  n: number,
  visible: boolean | null,
  certificationMark: CultureCategoryRow['certificationMark'] = null,
): CultureCategoryRow => ({ categoryId: c(n), visible, certificationMark });

describe('resolveEffectiveMarks', () => {
  // chain: 3 under 2 under 1 (root)
  const chain = [c(3), c(2), c(1)];

  it('defaults to visible and certification required with no row anywhere', () => {
    expect(resolveEffectiveMarks(chain, [])).toEqual({
      visible: true,
      certificationMark: 'required',
      visibleSource: { kind: 'default' },
      markSource: { kind: 'default' },
    });
  });

  it('ignores rows of categories outside the chain', () => {
    expect(resolveEffectiveMarks(chain, [row(9, false, 'neutral')]).visible).toBe(true);
  });

  it('inherits both values from the nearest ancestor that has a row', () => {
    const result = resolveEffectiveMarks(chain, [
      row(1, true, 'neutral'),
      row(2, true, 'required'),
    ]);
    expect(result).toMatchObject({
      visible: true,
      certificationMark: 'required',
      visibleSource: { kind: 'inherited', fromCategoryId: c(2) },
      markSource: { kind: 'inherited', fromCategoryId: c(2) },
    });
  });

  it('lets the category own row override its ancestors', () => {
    const result = resolveEffectiveMarks(chain, [
      row(1, true, 'required'),
      row(3, false, 'neutral'),
    ]);
    expect(result).toMatchObject({
      visible: false,
      certificationMark: 'neutral',
      visibleSource: { kind: 'own' },
      markSource: { kind: 'own' },
    });
  });

  it('resolves the mark through a row whose mark is null (inherit) and keeps its visibility', () => {
    const result = resolveEffectiveMarks(chain, [row(1, true, 'neutral'), row(2, false, null)]);
    expect(result).toMatchObject({
      visible: false,
      visibleSource: { kind: 'inherited', fromCategoryId: c(2) },
      certificationMark: 'neutral',
      markSource: { kind: 'inherited', fromCategoryId: c(1) },
    });
  });

  it('hides the whole branch under a hidden ancestor: a child row cannot show it again (ADR-0048 M2)', () => {
    const result = resolveEffectiveMarks(chain, [row(1, false, 'required'), row(3, true, null)]);
    expect(result).toMatchObject({
      visible: false,
      visibleSource: { kind: 'inherited', fromCategoryId: c(1) },
    });
  });

  it('a hidden parent and a child with only a neutral mark: hidden, and the mark is the child own', () => {
    const result = resolveEffectiveMarks(chain, [row(2, false, null), row(3, null, 'neutral')]);
    expect(result).toEqual({
      visible: false,
      visibleSource: { kind: 'inherited', fromCategoryId: c(2) },
      certificationMark: 'neutral',
      markSource: { kind: 'own' },
    });
  });

  it('a mark-only row (visible null) inherits visibility from above, or the default', () => {
    expect(resolveEffectiveMarks(chain, [row(3, null, 'neutral')])).toMatchObject({
      visible: true,
      visibleSource: { kind: 'default' },
    });
    expect(
      resolveEffectiveMarks(chain, [row(3, null, 'neutral'), row(1, true, null)]),
    ).toMatchObject({ visible: true, visibleSource: { kind: 'inherited', fromCategoryId: c(1) } });
  });

  it('falls back to the default mark when every row inherits it', () => {
    const result = resolveEffectiveMarks(chain, [row(2, false, null)]);
    expect(result.certificationMark).toBe('required');
    expect(result.markSource).toEqual({ kind: 'default' });
  });
});

describe('resolveTreeMarks', () => {
  it('resolves every category and survives a loop and a missing parent', () => {
    const nodes = [
      { id: c(1), parentId: null },
      { id: c(2), parentId: c(1) },
      { id: c(3), parentId: c(9) },
      { id: c(4), parentId: c(5) },
      { id: c(5), parentId: c(4) },
    ];
    const marks = resolveTreeMarks(nodes, [row(1, false, 'neutral')]);
    expect(marks.get(c(2))).toMatchObject({ visible: false, certificationMark: 'neutral' });
    expect(marks.get(c(3))).toMatchObject({ visible: true, certificationMark: 'required' });
    expect(marks.get(c(4))).toMatchObject({ visible: true });
    expect(marks.size).toBe(5);
  });
});

describe('parseCategoryMark', () => {
  it('defaults to visible with an inherited mark', () => {
    expect(parseCategoryMark({})).toEqual({
      ok: true,
      value: { visible: true, certificationMark: null },
    });
  });
  it('leaves visible to inherit (null) when only a mark is set (ADR-0048 M2)', () => {
    expect(parseCategoryMark({ certificationMark: 'neutral' })).toEqual({
      ok: true,
      value: { visible: null, certificationMark: 'neutral' },
    });
    expect(parseCategoryMark({ visible: null, certificationMark: 'neutral' })).toEqual({
      ok: true,
      value: { visible: null, certificationMark: 'neutral' },
    });
    expect(parseCategoryMark({ visible: false, certificationMark: 'neutral' })).toEqual({
      ok: true,
      value: { visible: false, certificationMark: 'neutral' },
    });
  });
  it('refuses a bad visible and an unknown mark together', () => {
    expect(parseCategoryMark({ visible: 'yes', certificationMark: 'REQUIRED' })).toEqual({
      ok: false,
      error: [
        { path: 'visible', code: 'type' },
        { path: 'certificationMark', code: 'unknown' },
      ],
    });
  });
});
