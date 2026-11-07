import { describe, expect, it } from 'vitest';
import { fromBase, placesOf, toBase } from './measure.ts';

describe('measure arithmetic (the seller form)', () => {
  it.each([
    ['500', 'g', '500'],
    ['0.5', 'kg', '500'],
    ['1.25', 'l', '1250'],
    ['2.5', 'cm', '25'],
    ['3', 'count', '3'],
    ['2.50', 'kg', '2500'],
  ])('%s %s is %s in base units', (amount, unit, base) => {
    expect(toBase(amount, unit)).toBe(base);
  });

  it('refuses text that is not a plain number, and a unit it does not know', () => {
    for (const bad of ['', '-1', '1e3', '1,5', ' 1', '01', '.5', '5.', '1'.repeat(30)]) {
      expect(toBase(bad, 'g')).toBeNull();
    }
    expect(toBase('1', 'oz')).toBeNull();
  });

  it('shows base units in another unit, rounded half up', () => {
    expect(fromBase('500', 'kg', 3)).toBe('0.5');
    expect(fromBase('1250', 'l', 3)).toBe('1.25');
    expect(fromBase('5', 'kg', 2)).toBe('0.01');
    expect(fromBase('4', 'kg', 2)).toBe('0');
    expect(fromBase('x', 'kg', 2)).toBeNull();
    expect(fromBase('1', 'kg', 9)).toBeNull();
  });

  it('counts decimal places without trailing zeros', () => {
    expect(placesOf('2')).toBe(0);
    expect(placesOf('2.50')).toBe(1);
    expect(placesOf('x')).toBeNull();
  });
});
