import { describe, expect, it } from 'vitest';
import { typicalOf, unusualOf } from './typical.ts';

const RANGE = { lowMinor: '890', highMinor: '2700' };

describe('typicalOf', () => {
  it('keeps only the sizes that have a range', () => {
    const state = typicalOf({
      offerId: 'o',
      variants: [
        { variantId: 'a', range: RANGE },
        { variantId: 'b', range: null },
      ],
    });
    expect([...state.keys()]).toEqual(['a']);
  });
});

describe('unusualOf', () => {
  it('is quiet without a range', () => {
    expect(unusualOf(undefined, 'AUD', '1.00', null)).toBeNull();
  });
  it('is quiet inside the range, edges included', () => {
    expect(unusualOf(RANGE, 'AUD', '8.90', null)).toBeNull();
    expect(unusualOf(RANGE, 'AUD', '27.00', null)).toBeNull();
    expect(unusualOf(RANGE, 'AUD', '12.50', null)).toBeNull();
  });
  it('names a price below or above', () => {
    expect(unusualOf(RANGE, 'AUD', '8.89', null)).toBe('below');
    expect(unusualOf(RANGE, 'AUD', '27.01', null)).toBe('above');
  });
  it('reads the typed text over the saved price', () => {
    expect(unusualOf(RANGE, 'AUD', '12.50', '100')).toBeNull();
    expect(unusualOf(RANGE, 'AUD', undefined, '100')).toBe('below');
  });
  it('is quiet while the text is not an amount, empty, or nothing is saved', () => {
    expect(unusualOf(RANGE, 'AUD', '12.', null)).toBeNull();
    expect(unusualOf(RANGE, 'AUD', '', '5000')).toBeNull();
    expect(unusualOf(RANGE, 'AUD', undefined, null)).toBeNull();
  });
  it('works for a currency with no decimals', () => {
    expect(unusualOf({ lowMinor: '100', highMinor: '300' }, 'JPY', '99', null)).toBe('below');
    expect(unusualOf({ lowMinor: '100', highMinor: '300' }, 'JPY', '301', null)).toBe('above');
  });
});
