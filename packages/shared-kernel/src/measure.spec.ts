import {
  canonicalDecimal,
  checkMeasure,
  compareDecimals,
  decimalPlaces,
  measureFromBase,
  measureToBase,
  type MeasureSettings,
} from './measure';

const MASS: MeasureSettings = {
  dimension: 'mass',
  units: ['g', 'kg'],
  defaultUnit: 'g',
  decimals: 2,
};

describe('measureToBase', () => {
  it.each([
    ['500', 'g', '500'],
    ['0.5', 'kg', '500'],
    ['1.25', 'l', '1250'],
    ['2.5', 'cm', '25'],
    ['0.001', 'm', '1'],
    ['3', 'count', '3'],
    ['0', 'g', '0'],
    ['2.50', 'kg', '2500'],
  ])('converts %s %s to %s base units', (entered, unit, base) => {
    expect(measureToBase(entered, unit, 3)).toBe(base);
  });

  it('refuses more decimal places than allowed, an unknown unit and non-decimal text', () => {
    expect(measureToBase('1.234', 'kg', 2)).toBeNull();
    expect(measureToBase('1', 'oz', 2)).toBeNull();
    for (const bad of ['', '-1', '1e3', '1,5', ' 1', '01', '.5', '5.', 'NaN']) {
      expect(measureToBase(bad, 'g', 2)).toBeNull();
    }
    expect(measureToBase('1'.repeat(40), 'g', 2)).toBeNull();
  });

  it('is exact where floating point is not (0.1 kg + 0.2 kg)', () => {
    expect(measureToBase('0.3', 'kg', 1)).toBe('300');
    expect(measureToBase('1.1', 'kg', 1)).toBe('1100');
  });
});

describe('measureFromBase', () => {
  it.each([
    ['500', 'kg', 3, '0.5'],
    ['1250', 'l', 3, '1.25'],
    ['1', 'kg', 3, '0.001'],
    ['1500', 'g', 0, '1500'],
    ['25', 'cm', 1, '2.5'],
  ])('shows %s base units in %s with %s places as %s', (base, unit, decimals, shown) => {
    expect(measureFromBase(base, unit, decimals)).toBe(shown);
  });

  it('rounds half up at the decimals given', () => {
    expect(measureFromBase('1', 'kg', 2)).toBe('0'); // 0.001 -> 0.00
    expect(measureFromBase('5', 'kg', 2)).toBe('0.01'); // 0.005 -> 0.01
    expect(measureFromBase('4', 'kg', 2)).toBe('0'); // 0.004 -> 0.00
    expect(measureFromBase('1495', 'kg', 2)).toBe('1.5'); // 1.495 -> 1.50
    expect(measureFromBase('1494', 'kg', 2)).toBe('1.49');
  });

  it('refuses invalid input', () => {
    expect(measureFromBase('x', 'g', 2)).toBeNull();
    expect(measureFromBase('1', 'oz', 2)).toBeNull();
    expect(measureFromBase('1', 'g', 7)).toBeNull();
    expect(measureFromBase('1', 'g', -1)).toBeNull();
  });

  it('round-trips what measureToBase stored', () => {
    for (const [entered, unit] of [
      ['0.75', 'kg'],
      ['12.5', 'cm'],
      ['3', 'count'],
    ] as const) {
      const base = measureToBase(entered, unit, 2);
      expect(base).not.toBeNull();
      expect(measureFromBase(base!, unit, 2)).toBe(entered);
    }
  });
});

describe('decimalPlaces', () => {
  it('counts places without trailing zeros', () => {
    expect(decimalPlaces('2')).toBe(0);
    expect(decimalPlaces('2.50')).toBe(1);
    expect(decimalPlaces('0.125')).toBe(3);
    expect(decimalPlaces('x')).toBeNull();
  });
});

describe('checkMeasure', () => {
  it('accepts a well-formed value in an offered unit', () => {
    expect(checkMeasure(MASS, { value: '500', unit: 'g' })).toBeNull();
    expect(checkMeasure(MASS, { value: '500', unit: 'kg' })).toBeNull();
    expect(checkMeasure(MASS, { value: '1250', unit: 'kg' })).toBeNull();
  });

  it('refuses the wrong shape', () => {
    for (const bad of [
      '500',
      500,
      null,
      [],
      { value: 500, unit: 'g' },
      { value: '500' },
      { value: '500', unit: 'g', extra: 1 },
      { value: '-5', unit: 'g' },
      { value: 'abc', unit: 'g' },
    ]) {
      expect(checkMeasure(MASS, bad)).toBe('type');
    }
  });

  it('refuses a unit the field does not offer, even a known one', () => {
    expect(checkMeasure(MASS, { value: '5', unit: 'ml' })).toBe('unit-unknown');
    expect(checkMeasure(MASS, { value: '5', unit: 'oz' })).toBe('unit-unknown');
    expect(checkMeasure({ ...MASS, units: ['g'] }, { value: '5', unit: 'kg' })).toBe(
      'unit-unknown',
    );
  });

  it('refuses more decimal places than the field allows in the unit picked', () => {
    // 1 g = 0.001 kg: three places, the field allows two.
    expect(checkMeasure(MASS, { value: '1', unit: 'kg' })).toBe('precision');
    // 1.5 g is not a whole gram when the field is in g with no places.
    expect(checkMeasure({ ...MASS, decimals: 0 }, { value: '1.5', unit: 'g' })).toBe('precision');
    expect(checkMeasure({ ...MASS, decimals: 0 }, { value: '1500', unit: 'kg' })).toBe('precision');
  });
});

describe('exact decimal text', () => {
  it('stores one text per number: trailing zeros are refused, not rounded away', () => {
    expect(canonicalDecimal('500.0')).toBe('500');
    expect(canonicalDecimal('2.50')).toBe('2.5');
    expect(canonicalDecimal('01')).toBeNull();
    expect(checkMeasure(MASS, { value: '500.0', unit: 'g' })).toBe('type');
    expect(checkMeasure(MASS, { value: '500', unit: 'g' })).toBeNull();
  });

  it('compares without floating point, past the 15 digits a double keeps', () => {
    expect(compareDecimals('999999999999.999999999', '999999999999.999999998')).toBe(1);
    expect(compareDecimals('0.1', '0.10')).toBe(0);
    expect(compareDecimals('2', '10')).toBe(-1);
    expect(compareDecimals('x', '1')).toBeNull();
  });

  it('refuses an over-precise value that a double would round into an exact one', () => {
    // 12 + 9 digits: as a double this equals 500 g, but it is 500.000000001 g.
    expect(checkMeasure({ ...MASS, decimals: 6 }, { value: '500.000000001', unit: 'g' })).toBe(
      'precision',
    );
  });
});
