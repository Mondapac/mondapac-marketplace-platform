import { describe, expect, it } from 'vitest';
import { DEFAULT_HANDLING, defaultCondition, offerDefaultsOf } from './offer-defaults.ts';

describe('offerDefaultsOf', () => {
  it('copies the condition and handling of the newest offer that has a handling', () => {
    expect(
      offerDefaultsOf(
        [
          { conditionCode: 'new', handling: null },
          { conditionCode: 'used', handling: 'FRESH' },
          { conditionCode: 'new', handling: 'REPACKED' },
        ],
        ['new', 'used'],
      ),
    ).toEqual({ condition: 'used', handling: 'FRESH', fromLastOffer: true });
  });
  it('starts as Sealed original with the Market default when no offer has a handling', () => {
    expect(offerDefaultsOf([{ conditionCode: 'used', handling: null }], ['used', 'new'])).toEqual({
      condition: 'new',
      handling: DEFAULT_HANDLING,
      fromLastOffer: false,
    });
    expect(DEFAULT_HANDLING).toBe('SEALED_ORIGINAL');
    expect(offerDefaultsOf([], ['used'])?.condition).toBe('used');
  });
  it('does not copy a condition the Market no longer has', () => {
    expect(
      offerDefaultsOf([{ conditionCode: 'refurbished', handling: 'PREPARED' }], ['new', 'used']),
    ).toEqual({ condition: 'new', handling: 'PREPARED', fromLastOffer: true });
  });
  it('makes no draft when the Market has no condition', () => {
    expect(offerDefaultsOf([{ conditionCode: 'new', handling: 'FRESH' }], [])).toBeNull();
    expect(defaultCondition([])).toBeNull();
  });
});
