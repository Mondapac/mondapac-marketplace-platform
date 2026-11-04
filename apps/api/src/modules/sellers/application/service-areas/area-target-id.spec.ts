import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { areaTargetId } from './area-target-id';

describe('areaTargetId', () => {
  it('gives the same version 7 id for a Market and code, and another for another', () => {
    const au = testMarketContext('AU', 'default');
    const zz = testMarketContext('ZZ', 'default');
    expect(areaTargetId(au, 'greater-brisbane')).toBe(areaTargetId(au, 'greater-brisbane'));
    expect(areaTargetId(au, 'greater-brisbane')).not.toBe(areaTargetId(zz, 'greater-brisbane'));
    expect(areaTargetId(au, 'greater-brisbane')).not.toBe(areaTargetId(au, 'gold-coast'));
    expect(areaTargetId(au, 'gold-coast')[14]).toBe('7');
  });

  it('is pinned: the audit rows of existing edits name this id, so the derivation never changes', () => {
    const au = testMarketContext('AU', 'default');
    expect(areaTargetId(au, 'greater-brisbane')).toBe('69449e20-755d-7050-932d-073d011f190c');
  });
});
