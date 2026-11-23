import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../test/support/test-config';
import { loadMarketConfigs } from './market-config';
import { postcodeRegionsSchema, regionOfPostcode } from './postcode-regions';

// The postcode-to-region table of `shipping.postcodeRegions` (dashboards v2, phase 1): Market
// configuration, never code. Both checked-in fixtures carry one; every postcode their pattern
// accepts at the range edges maps to exactly one region of their customer address list.

const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

const CASES: Record<string, readonly (readonly [string, string | null])[]> = {
  AU: [
    ['4000', 'QLD'],
    ['4999', 'QLD'],
    ['2000', 'NSW'],
    ['2600', 'ACT'],
    ['2619', 'NSW'],
    ['0800', 'NT'],
    ['0200', 'ACT'],
    ['3000', 'VIC'],
    ['6000', 'WA'],
    ['0100', null],
    ['400', null],
  ],
  ZZ: [
    ['0000000', 'ZA'],
    ['4999999', 'ZA'],
    ['5000000', 'ZB'],
    ['9999999', 'ZB'],
    ['4000', null],
  ],
};

describe.each(TEST_MARKET_IDS)('postcode regions in market %s', (code) => {
  const config = markets.get(code);
  const table = config?.shipping?.postcodeRegions;

  it('maps a postcode to its region, and one in no range (or of another length) to none', () => {
    expect(table).toBeDefined();
    for (const [postcode, region] of CASES[code] ?? []) {
      expect([postcode, regionOfPostcode(table, postcode)]).toEqual([postcode, region]);
    }
  });

  it('names only regions of the Market customer addresses, as codes of 1 to 3 characters', () => {
    const regions = config?.customers?.address.regions ?? [];
    for (const region of Object.keys(table ?? {})) {
      expect(regions).toContain(region);
      expect(region).toMatch(/^[A-Z0-9]{1,3}$/u);
    }
  });
});

describe('postcode regions table', () => {
  it('has no region without a table', () => {
    expect(regionOfPostcode(undefined, '4000')).toBeNull();
  });

  it('refuses overlapping ranges, a reversed range, mixed lengths and a long region code', () => {
    const refused = [
      { A: [['1000', '1999']], B: [['1500', '2500']] },
      { A: [['2000', '1000']] },
      { A: [['100', '1999']] },
      { ABCD: [['1000', '1999']] },
      { a: [['1000', '1999']] },
      { A: [] },
    ];
    for (const table of refused) expect(postcodeRegionsSchema.safeParse(table).success).toBe(false);
    // Ranges of different lengths never overlap: a postcode has one length.
    expect(
      postcodeRegionsSchema.safeParse({ A: [['100', '199']], B: [['1000', '1999']] }).success,
    ).toBe(true);
  });
});
