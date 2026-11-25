import { describe, expect, it } from 'vitest';
import { defaultCondition, offerDefaultsOf } from './offer-defaults.ts';

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
  it('declares no handling for the seller when no offer of theirs has one', () => {
    expect(offerDefaultsOf([{ conditionCode: 'used', handling: null }], ['used', 'new'])).toEqual({
      condition: 'new',
      handling: null,
      fromLastOffer: false,
    });
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
