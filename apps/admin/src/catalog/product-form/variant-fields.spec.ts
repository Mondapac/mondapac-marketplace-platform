import { describe, expect, it } from 'vitest';
import { NO_VARIANT_FIELDS } from './draft-content.ts';
import {
  gtinKey,
  gtinProblem,
  hasProblems,
  problemsOf,
  problemsOfRows,
  sizeProblem,
} from './variant-fields.ts';

describe('variant field checks', () => {
  it('accepts GTIN-8, 12, 13 and 14 with a right check digit, and keeps 14 digits', () => {
    expect(gtinProblem('')).toBeNull();
    expect(gtinKey('96385074')).toBe('00000096385074');
    expect(gtinKey('0 36000-29145 2')).toBe('00036000291452');
    expect(gtinKey('4006381333931')).toBe('04006381333931');
    expect(gtinKey('04006381333931')).toBe('04006381333931');
  });

  it('refuses a wrong check digit, a wrong length and letters', () => {
    expect(gtinProblem('4006381333932')).toBe('invalid');
    expect(gtinProblem('12345')).toBe('invalid');
    expect(gtinProblem('40063813339ab')).toBe('invalid');
  });

  it('keeps sizes to whole numbers in range', () => {
    expect(sizeProblem('weightGrams', '')).toBeNull();
    expect(sizeProblem('weightGrams', '1000000')).toBeNull();
    expect(sizeProblem('weightGrams', '1000001')).toBe('invalid');
    expect(sizeProblem('lengthMm', '100000')).toBeNull();
    expect(sizeProblem('lengthMm', '100001')).toBe('invalid');
    expect(sizeProblem('lengthMm', '0')).toBe('invalid');
    expect(sizeProblem('lengthMm', '1.5')).toBe('invalid');
    expect(sizeProblem('lengthMm', '-3')).toBe('invalid');
  });

  it('wants all three box sides or none', () => {
    expect(problemsOf({ ...NO_VARIANT_FIELDS, lengthMm: '5' }, [])).toEqual({
      widthMm: 'required',
      heightMm: 'required',
    });
    expect(
      problemsOf({ ...NO_VARIANT_FIELDS, lengthMm: '5', widthMm: '5', heightMm: '5' }, []),
    ).toEqual({});
  });

  it('marks a barcode twin among the rows on both, and a 12-digit twin of a 13-digit code', () => {
    const rows = [
      { ...NO_VARIANT_FIELDS, gtin: '036000291452' },
      { ...NO_VARIANT_FIELDS, gtin: '0036000291452' },
      { ...NO_VARIANT_FIELDS, gtin: '' },
    ];
    const list = problemsOfRows(rows);
    expect(list[0]?.gtin).toBe('duplicate');
    expect(list[1]?.gtin).toBe('duplicate');
    expect(list[2]).toEqual({});
    expect(hasProblems(list)).toBe(true);
    expect(hasProblems([{}, {}])).toBe(false);
  });

  it('caps the photo picks at 20', () => {
    const ids = Array.from({ length: 21 }, (_, i) => `i${i}`);
    expect(problemsOf({ ...NO_VARIANT_FIELDS, imageIds: ids }, [])).toEqual({
      imageIds: 'too-many',
    });
  });
});
