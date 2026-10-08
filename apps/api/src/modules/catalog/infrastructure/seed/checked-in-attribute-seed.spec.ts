import { testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  AttributeSeedError,
  CheckedInAttributeSeed,
  assertAttributeSeed,
} from './checked-in-attribute-seed';
import { ZZ_ATTRIBUTE_DEFINITIONS, ZZ_ATTRIBUTE_FAMILIES } from './zz.attributes.seed';

describe('the checked-in attribute seed', () => {
  it('gives the fixture Market its lists and every other Market empty ones', () => {
    const seed = new CheckedInAttributeSeed();
    expect(seed.definitions(testMarketContext('ZZ', 'default'))).toBe(ZZ_ATTRIBUTE_DEFINITIONS);
    expect(seed.families(testMarketContext('ZZ', 'default'))).toBe(ZZ_ATTRIBUTE_FAMILIES);
    expect(seed.definitions(testMarketContext('AU', 'default'))).toEqual([]);
    expect(seed.families(testMarketContext('AU', 'default'))).toEqual([]);
  });

  it('accepts the fixture seed', () => {
    expect(() =>
      assertAttributeSeed({
        definitions: ZZ_ATTRIBUTE_DEFINITIONS,
        families: ZZ_ATTRIBUTE_FAMILIES,
      }),
    ).not.toThrow();
  });

  it('refuses a repeated code, a repeated family and a family naming an unknown attribute', () => {
    const [first] = ZZ_ATTRIBUTE_DEFINITIONS;
    expect(() => assertAttributeSeed({ definitions: [first!, first!], families: [] })).toThrow(
      AttributeSeedError,
    );
    const [family] = ZZ_ATTRIBUTE_FAMILIES;
    expect(() =>
      assertAttributeSeed({ definitions: ZZ_ATTRIBUTE_DEFINITIONS, families: [family!, family!] }),
    ).toThrow(AttributeSeedError);
    expect(() => assertAttributeSeed({ definitions: [first!], families: [family!] })).toThrow(
      AttributeSeedError,
    );
  });
});
