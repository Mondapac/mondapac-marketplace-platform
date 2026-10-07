import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { parseMarketId } from '@mondapac/shared-kernel';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
  testMarketId,
} from '../../../test/support/test-config';
import { InvalidMarketConfigError, loadMarketConfigs } from './market-config';
import { MarketNotHostedError, MarketRegistry } from './market-registry';

const QQ = testMarketId('QQ');

const VALID = {
  code: 'QQ',
  status: 'active',
  defaultLocale: 'en-NZ',
  supportedLocales: ['en-NZ'],
  defaultCurrency: 'NZD',
  settlementCurrency: 'NZD',
  timezone: 'Pacific/Auckland',
};

function directoryWith(files: Record<string, unknown>): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'markets-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      path.join(directory, name),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return directory;
}

describe('loadMarketConfigs', () => {
  it('loads every hosted market from the repository configuration and the fixtures', () => {
    const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

    expect([...markets.keys()]).toEqual([...TEST_MARKETS]);
    for (const code of TEST_MARKETS) {
      const market = markets.get(testMarketId(code));
      expect(market?.code).toBe(code);
      expect(market?.supportedLocales).toContain(market?.defaultLocale);
    }
  });

  it('keeps the two fixtures different in currency, locale and time zone', () => {
    const [first, second] = [
      ...loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS).values(),
    ];

    expect(first?.defaultCurrency).not.toBe(second?.defaultCurrency);
    expect(first?.defaultLocale).not.toBe(second?.defaultLocale);
    expect(first?.timezone).not.toBe(second?.timezone);
  });

  it('loads only the hosted markets', () => {
    const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, [testMarketId('ZZ')]);

    expect([...markets.keys()]).toEqual(['ZZ']);
  });

  it('fails when a hosted market has no configuration file', () => {
    const hosted = ['AU', 'NZ'].map(testMarketId);

    expect(() => loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, hosted)).toThrow(
      /Hosted market "NZ" has no configuration file/,
    );
  });

  it.each([
    ['an unknown currency', { defaultCurrency: 'XXQ' }, /defaultCurrency/],
    ['an unknown time zone', { timezone: 'Mars/Olympus' }, /timezone/],
    [
      'a malformed locale',
      { defaultLocale: 'english', supportedLocales: ['english'] },
      /defaultLocale/,
    ],
    ['a default locale that is not supported', { supportedLocales: ['mi-NZ'] }, /supportedLocales/],
    ['an unknown status', { status: 'live' }, /status/],
    ['an unknown field', { vatRate: 0.15 }, /vatRate|Unrecognized/],
    ['a code that differs from the file name', { code: 'QX' }, /must match the file name/],
  ])('rejects %s', (_case, overrides, message) => {
    const directory = directoryWith({ 'QQ.json': { ...VALID, ...overrides } });

    expect(() => loadMarketConfigs([directory], [QQ])).toThrow(InvalidMarketConfigError);
    expect(() => loadMarketConfigs([directory], [QQ])).toThrow(message);
  });

  describe('the sellers section', () => {
    const SELLERS = {
      address: {
        fields: [
          { key: 'line1', labelKey: 'k.line1', required: true, maxLength: 120 },
          { key: 'zip', labelKey: 'k.zip', required: true, maxLength: 5 },
          { key: 'region', labelKey: 'k.region', required: true, maxLength: 10 },
        ],
        postcodeField: 'zip',
        regionField: 'region',
        postcodePattern: '^[0-9]{5}$',
        regions: ['N', 'S'],
      },
      timezones: {
        byRegion: { N: 'Pacific/Auckland', S: 'Pacific/Auckland' },
        postcodeExceptions: [{ postcodes: ['90000-90010', 'AB1'], timezone: 'Pacific/Chatham' }],
      },
    };
    const withSellers = (sellers: unknown) => directoryWith({ 'QQ.json': { ...VALID, sellers } });
    const mutate = (change: (copy: typeof SELLERS) => void) => {
      const copy = structuredClone(SELLERS);
      change(copy);
      return copy;
    };

    it('is optional, and loads when valid', () => {
      expect(loadMarketConfigs([directoryWith({ 'QQ.json': VALID })], [QQ]).get(QQ)?.sellers).toBe(
        undefined,
      );
      expect(
        loadMarketConfigs([withSellers(SELLERS)], [QQ]).get(QQ)?.sellers?.address.regions,
      ).toEqual(['N', 'S']);
    });

    it('is present, and different, in both Market fixtures', () => {
      const [first, second] = [
        ...loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS).values(),
      ];

      expect(first?.sellers).toBeDefined();
      expect(second?.sellers).toBeDefined();
      expect(first?.sellers?.address.postcodePattern).not.toBe(
        second?.sellers?.address.postcodePattern,
      );
      expect(first?.sellers?.address.fields.map((f) => f.key)).not.toEqual(
        second?.sellers?.address.fields.map((f) => f.key),
      );
    });

    it.each([
      [
        'an unknown time zone',
        (c: typeof SELLERS) => void (c.timezones.byRegion.N = 'Mars/Olympus'),
        /byRegion/,
      ],
      [
        'a region without a zone',
        (c: typeof SELLERS) => void delete (c.timezones.byRegion as Record<string, string>).S,
        /exactly the regions/,
      ],
      [
        'a zone for an unknown region',
        (c: typeof SELLERS) =>
          void ((c.timezones.byRegion as Record<string, string>).X = 'Asia/Tokyo'),
        /exactly the regions/,
      ],
      [
        'a postcode field that is not a field',
        (c: typeof SELLERS) => void (c.address.postcodeField = 'nope'),
        /postcodeField/,
      ],
      [
        'duplicate field keys',
        (c: typeof SELLERS) => void (c.address.fields[1]!.key = 'line1'),
        /unique/,
      ],
      [
        'a pattern that is not a regular expression',
        (c: typeof SELLERS) => void (c.address.postcodePattern = '('),
        /regular expression/,
      ],
      [
        'a field limit above 120',
        (c: typeof SELLERS) => void (c.address.fields[0]!.maxLength = 121),
        /maxLength/,
      ],
      [
        'a region field without regions',
        (c: typeof SELLERS) => void (c.address.regions = []),
        /regionField/,
      ],
      [
        'a malformed exception postcode',
        (c: typeof SELLERS) => void (c.timezones.postcodeExceptions[0]!.postcodes = ['9-!']),
        /postcode or a digit range/,
      ],
    ])('rejects %s', (_case, change, message) => {
      const directory = withSellers(mutate(change));

      expect(() => loadMarketConfigs([directory], [QQ])).toThrow(InvalidMarketConfigError);
      expect(() => loadMarketConfigs([directory], [QQ])).toThrow(message);
    });

    it('rejects an unknown key', () => {
      expect(() => loadMarketConfigs([withSellers({ ...SELLERS, vatRate: 1 })], [QQ])).toThrow(
        InvalidMarketConfigError,
      );
    });
  });

  it('rejects a file that is not JSON', () => {
    const directory = directoryWith({ 'QQ.json': '{ not json' });

    expect(() => loadMarketConfigs([directory], [QQ])).toThrow(/is not valid JSON/);
  });

  it('rejects a market configured in two directories', () => {
    const first = directoryWith({ 'QQ.json': VALID });
    const second = directoryWith({ 'QQ.json': VALID });

    expect(() => loadMarketConfigs([first, second], [QQ])).toThrow(/more than once/);
  });
});

describe('the Market fixtures', () => {
  // Platform-foundations design section 9: the kernel specs cannot read these files, so the
  // kernel's single Market rule is asserted against them here.
  it('name every configuration file with a code the kernel parseMarketId accepts', () => {
    const codes = TEST_MARKET_CONFIG_DIRS.flatMap((directory) =>
      readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length)),
    );

    expect(codes).toEqual(expect.arrayContaining([...TEST_MARKETS]));
    for (const code of codes) expect(parseMarketId(code).ok).toBe(true);
  });

  it('give the loaded configurations parsed codes', () => {
    for (const market of loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS).values()) {
      expect(parseMarketId(market.code)).toEqual({ ok: true, value: market.code });
    }
  });
});

describe('MarketRegistry', () => {
  const registry = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

  it.each(TEST_MARKETS)('returns the configuration of hosted market %s', (code) => {
    expect(registry.isHosted(testMarketId(code))).toBe(true);
    expect(registry.get(testMarketId(code)).code).toBe(code);
  });

  it('lists the hosted markets in HOSTED_MARKETS order', () => {
    expect(registry.hostedMarketIds()).toEqual([...TEST_MARKETS]);
  });

  it('rejects a market this Region Stack does not host', () => {
    expect(registry.isHosted(testMarketId('NZ'))).toBe(false);
    expect(() => registry.get(testMarketId('NZ'))).toThrow(MarketNotHostedError);
  });
});
