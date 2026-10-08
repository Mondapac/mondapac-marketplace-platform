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
  requestLimits: { anonymousIdentityPerMinute: 20, defaultPerMinute: 300 },
  allowedOrigins: ['https://shop.qq.test'],
  identity: {
    password: { minLength: 15, maxLength: 128 },
    existingAccountNoticeHours: 24,
    sessions: { customer: { idleTimeoutMinutes: 60, absoluteLifetimeMinutes: 120 } },
    keepSignedInSessions: {},
    signInThrottles: {
      accountOrigin: { limit: 5, windowMinutes: 15, blockMinutes: 15 },
      account: { limit: 20, windowMinutes: 60, blockMinutes: 60 },
      origin: { limit: 30, windowMinutes: 15, blockMinutes: 15 },
    },
    mailThrottles: {
      account: { limit: 3, windowMinutes: 60, blockMinutes: 0 },
      origin: { limit: 10, windowMinutes: 60, blockMinutes: 0 },
    },
    signInRecordRetentionDays: 90,
    links: {
      lifetimeMinutes: { 'verify-email': 1440, 'reset-password': 60 },
      targets: {
        customer: {
          'verify-email': 'https://shop.qq.test/confirm-email',
          'sign-in': 'https://shop.qq.test/sign-in',
          'reset-password': 'https://shop.qq.test/reset-password',
        },
      },
    },
    unverifiedAccountRetentionDays: 7,
    mail: { fromAddress: 'no-reply@qq.test', fromName: 'QQ' },
  },
};
const IDENTITY = VALID.identity;

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

  it('freezes every section, so no caller can change a policy value after boot', () => {
    const market = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS).get(
      testMarketId('AU'),
    );

    expect(Object.isFrozen(market)).toBe(true);
    expect(Object.isFrozen(market?.requestLimits)).toBe(true);
    expect(Object.isFrozen(market?.identity.password)).toBe(true);
  });

  it('gives the synthetic Market other limits and password rules than the launch Market', () => {
    const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
    const [au, zz] = [markets.get(testMarketId('AU')), markets.get(testMarketId('ZZ'))];

    expect(zz?.requestLimits).not.toEqual(au?.requestLimits);
    expect(zz?.identity.password).not.toEqual(au?.identity.password);
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
    ['no request limits', { requestLimits: undefined }, /requestLimits/],
    [
      'a zero request limit',
      { requestLimits: { anonymousIdentityPerMinute: 0, defaultPerMinute: 300 } },
      /requestLimits\.anonymousIdentityPerMinute/,
    ],
    ['no identity section', { identity: undefined }, /identity/],
    [
      'a password minimum below 15',
      { identity: { ...IDENTITY, password: { minLength: 8, maxLength: 128 } } },
      /identity\.password\.minLength/,
    ],
    [
      'a password maximum above 128',
      { identity: { ...IDENTITY, password: { minLength: 15, maxLength: 1024 } } },
      /identity\.password\.maxLength/,
    ],
    ['an unknown identity field', { identity: { ...IDENTITY, pepper: 'x' } }, /identity/],
    [
      'a link page with a fragment',
      {
        identity: {
          ...IDENTITY,
          links: {
            ...IDENTITY.links,
            targets: {
              customer: { ...IDENTITY.links.targets.customer, 'verify-email': 'https://a.test/#x' },
            },
          },
        },
      },
      /identity\.links\.targets\.customer\.verify-email/,
    ],
    [
      'a link page that is not http(s)',
      {
        identity: {
          ...IDENTITY,
          links: {
            ...IDENTITY.links,
            targets: {
              customer: { ...IDENTITY.links.targets.customer, 'sign-in': 'javascript:alert(1)' },
            },
          },
        },
      },
      /identity\.links\.targets\.customer\.sign-in/,
    ],
    [
      'a link page on plain http to a non-loopback host (Hassan L4)',
      {
        identity: {
          ...IDENTITY,
          links: {
            ...IDENTITY.links,
            targets: {
              customer: {
                ...IDENTITY.links.targets.customer,
                'verify-email': 'http://shop.qq.test/confirm-email',
              },
            },
          },
        },
      },
      /identity\.links\.targets\.customer\.verify-email/,
    ],
    [
      'a verification link living longer than 24 hours (Hassan L3)',
      {
        identity: {
          ...IDENTITY,
          links: {
            ...IDENTITY.links,
            lifetimeMinutes: { 'verify-email': 1441, 'reset-password': 60 },
          },
        },
      },
      /identity\.links\.lifetimeMinutes\.verify-email/,
    ],
    [
      'a reset link that is not exactly 60 minutes (SEL-05, ACC-04)',
      {
        identity: {
          ...IDENTITY,
          links: {
            ...IDENTITY.links,
            lifetimeMinutes: { 'verify-email': 1440, 'reset-password': 30 },
          },
        },
      },
      /identity\.links\.lifetimeMinutes\.reset-password/,
    ],
    [
      'no reset link lifetime',
      {
        identity: {
          ...IDENTITY,
          links: { ...IDENTITY.links, lifetimeMinutes: { 'verify-email': 1440 } },
        },
      },
      /identity\.links\.lifetimeMinutes\.reset-password/,
    ],
    [
      'no reset page for the customer',
      {
        identity: {
          ...IDENTITY,
          links: {
            ...IDENTITY.links,
            targets: {
              customer: {
                'verify-email': 'https://shop.qq.test/confirm-email',
                'sign-in': 'https://shop.qq.test/sign-in',
              },
            },
          },
        },
      },
      /identity\.links\.targets\.customer\.reset-password/,
    ],
    [
      'a link lifetime of zero',
      {
        identity: {
          ...IDENTITY,
          links: {
            ...IDENTITY.links,
            lifetimeMinutes: { 'verify-email': 0, 'reset-password': 60 },
          },
        },
      },
      /identity\.links\.lifetimeMinutes/,
    ],
    [
      'a sender name with a line break',
      { identity: { ...IDENTITY, mail: { fromAddress: 'a@qq.test', fromName: 'QQ\nBcc: x' } } },
      /identity\.mail\.fromName/,
    ],
    [
      'a sender address that is not an email',
      { identity: { ...IDENTITY, mail: { fromAddress: 'not-an-email', fromName: 'QQ' } } },
      /identity\.mail\.fromAddress/,
    ],
    [
      'an unverified retention above 30 days',
      { identity: { ...IDENTITY, unverifiedAccountRetentionDays: 31 } },
      /identity\.unverifiedAccountRetentionDays/,
    ],
    [
      'an idle timeout longer than the absolute lifetime',
      {
        identity: {
          ...IDENTITY,
          sessions: { customer: { idleTimeoutMinutes: 121, absoluteLifetimeMinutes: 120 } },
        },
      },
      /identity\.sessions\.customer\.idleTimeoutMinutes/,
    ],
    [
      'a seller session idle longer than its absolute lifetime',
      {
        identity: {
          ...IDENTITY,
          sessions: {
            ...IDENTITY.sessions,
            seller: { idleTimeoutMinutes: 1441, absoluteLifetimeMinutes: 1440 },
          },
        },
      },
      /identity\.sessions\.seller\.idleTimeoutMinutes/,
    ],
    [
      '"keep me signed in" for the customer population (seller side only, 6.1)',
      {
        identity: {
          ...IDENTITY,
          keepSignedInSessions: {
            customer: { idleTimeoutMinutes: 60, absoluteLifetimeMinutes: 120 },
          },
        },
      },
      /identity\.keepSignedInSessions/,
    ],
    [
      'a throttle limit of zero',
      {
        identity: {
          ...IDENTITY,
          signInThrottles: {
            ...IDENTITY.signInThrottles,
            origin: { limit: 0, windowMinutes: 15, blockMinutes: 15 },
          },
        },
      },
      /identity\.signInThrottles\.origin\.limit/,
    ],
    ['no allowed origins', { allowedOrigins: undefined }, /allowedOrigins/],
    [
      'an allowed origin with a path',
      { allowedOrigins: ['https://shop.qq.test/'] },
      /allowedOrigins\.0/,
    ],
    [
      'an allowed origin that is not http(s)',
      { allowedOrigins: ['ftp://shop.qq.test'] },
      /allowedOrigins/,
    ],
  ])('rejects %s', (_case, overrides, message) => {
    const directory = directoryWith({ 'QQ.json': { ...VALID, ...overrides } });

    expect(() => loadMarketConfigs([directory], [QQ])).toThrow(InvalidMarketConfigError);
    expect(() => loadMarketConfigs([directory], [QQ])).toThrow(message);
  });

  it.each([
    'http://localhost:3001/confirm-email',
    'http://storefront.localhost/confirm-email',
    'http://127.0.0.1:3001/confirm-email',
    'http://[::1]:3001/confirm-email',
    'https://shop.qq.test/confirm-email',
  ])('accepts the link page %s, with a 24-hour verification link', (page) => {
    const identity = {
      ...IDENTITY,
      links: {
        lifetimeMinutes: { 'verify-email': 1440, 'reset-password': 60 },
        targets: { customer: { ...IDENTITY.links.targets.customer, 'verify-email': page } },
      },
    };
    const directory = directoryWith({ 'QQ.json': { ...VALID, identity } });

    expect(loadMarketConfigs([directory], [QQ]).get(QQ)!.identity.links).toEqual(identity.links);
  });

  describe('the sellers section', () => {
    const SELLERS = {
      approvalRequired: true,
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
        countries: ['NZ'],
        byRegion: {
          N: { default: 'Pacific/Auckland', selectable: ['Pacific/Auckland', 'Pacific/Chatham'] },
          S: { default: 'Pacific/Auckland', selectable: ['Pacific/Auckland'] },
        },
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

    it('lists, in every region of both fixtures, a default inside selectable; one ZZ region has two zones', () => {
      const fixtures = [...loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS).values()];
      const regions = fixtures.flatMap((market) =>
        Object.values(market.sellers?.timezones.byRegion ?? {}),
      );

      expect(regions.length).toBeGreaterThan(0);
      for (const zones of regions) expect(zones.selectable).toContain(zones.default);
      const synthetic = fixtures.find((market) => market.code !== 'AU');
      expect(
        Object.values(synthetic?.sellers?.timezones.byRegion ?? {}).some(
          (zones) => zones.selectable.length > 1,
        ),
      ).toBe(true);
    });

    it.each([
      [
        'no approval policy: a Market never defaults it',
        (c: typeof SELLERS) => void delete (c as { approvalRequired?: boolean }).approvalRequired,
        /approvalRequired/,
      ],
      [
        'an unknown time zone',
        (c: typeof SELLERS) => void (c.timezones.byRegion.N.selectable[1] = 'Mars/Olympus'),
        /IANA time zone/,
      ],
      [
        'a default that is not in the selectable list',
        (c: typeof SELLERS) => void (c.timezones.byRegion.S.default = 'Pacific/Chatham'),
        /default must be one of selectable/,
      ],
      [
        'a selectable list that repeats a zone',
        (c: typeof SELLERS) => void c.timezones.byRegion.S.selectable.push('Pacific/Auckland'),
        /must not repeat/,
      ],
      [
        'an empty selectable list',
        (c: typeof SELLERS) => void (c.timezones.byRegion.S.selectable = []),
        /expected array to have >=1 items/,
      ],
      [
        'a backward link instead of the canonical zone',
        (c: typeof SELLERS) => {
          c.timezones.byRegion.S.default = 'Australia/NSW';
          c.timezones.byRegion.S.selectable = ['Australia/NSW'];
        },
        /IANA time zone/,
      ],
      [
        'a zone of another country than timezones.countries',
        (c: typeof SELLERS) => {
          c.timezones.byRegion.S.default = 'Asia/Tokyo';
          c.timezones.byRegion.S.selectable = ['Asia/Tokyo'];
        },
        /does not belong to any of timezones.countries/,
      ],
      [
        'a country with no zones',
        (c: typeof SELLERS) => void (c.timezones.countries = ['NZ', 'XX']),
        /no time zones in the runtime/,
      ],
      ['no countries', (c: typeof SELLERS) => void (c.timezones.countries = []), /timezones/],
      [
        'a country that is not an ISO code',
        (c: typeof SELLERS) => void (c.timezones.countries = ['nz']),
        /ISO 3166-1/,
      ],
      [
        'an Etc zone',
        (c: typeof SELLERS) => {
          c.timezones.byRegion.S.default = 'Etc/GMT+5';
          c.timezones.byRegion.S.selectable = ['Etc/GMT+5'];
        },
        /IANA time zone/,
      ],
      [
        'an offset instead of a zone',
        (c: typeof SELLERS) => {
          c.timezones.byRegion.S.default = '+10:00';
          c.timezones.byRegion.S.selectable = ['+10:00'];
        },
        /IANA time zone/,
      ],
      [
        'a region without a zone',
        (c: typeof SELLERS) => void delete (c.timezones.byRegion as Record<string, unknown>).S,
        /exactly the regions/,
      ],
      [
        'a zone for an unknown region',
        (c: typeof SELLERS) =>
          void ((c.timezones.byRegion as Record<string, unknown>).X = {
            default: 'Asia/Tokyo',
            selectable: ['Asia/Tokyo'],
          }),
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
        'a pattern that backtracks catastrophically',
        (c: typeof SELLERS) => void (c.address.postcodePattern = '^(a+)+$'),
        /bounded/,
      ],
      [
        'an unanchored pattern',
        (c: typeof SELLERS) => void (c.address.postcodePattern = '[0-9]{5}'),
        /anchored/,
      ],
      [
        'a pattern with a back-reference or lookahead',
        (c: typeof SELLERS) => void (c.address.postcodePattern = '^(?=[0-9]{5}$)[0-9]+$'),
        /lookaround/,
      ],
      [
        'a pattern longer than 64 characters',
        (c: typeof SELLERS) => void (c.address.postcodePattern = `^${'[0-9]'.repeat(20)}$`),
        /<=64 characters/,
      ],
      [
        'a field key that shadows Object.prototype',
        (c: typeof SELLERS) => void (c.address.fields[0]!.key = 'constructor'),
        /Object.prototype/,
      ],
      [
        'a region named like an Object.prototype member',
        (c: typeof SELLERS) => void (c.address.regions[0] = 'toString'),
        /Object.prototype/,
      ],
      [
        'the postcode and region in one field',
        (c: typeof SELLERS) => void (c.address.regionField = c.address.postcodeField),
        /must differ/,
      ],
      [
        'an optional postcode field',
        (c: typeof SELLERS) => void (c.address.fields[1]!.required = false),
        /must be required/,
      ],
      [
        'a region longer than the region field allows',
        (c: typeof SELLERS) => void (c.address.regions[0] = 'x'.repeat(40)),
        /fit the maxLength/,
      ],
      [
        'more than 100 regions',
        (c: typeof SELLERS) =>
          void (c.address.regions = Array.from({ length: 101 }, (_, i) => `r${i}`)),
        /100|Too big/i,
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

  describe('the inventory section', () => {
    const withInventory = (inventory: unknown) =>
      directoryWith({ 'QQ.json': { ...VALID, inventory } });

    it('is optional for a Market that does not host inventory', () => {
      expect(
        loadMarketConfigs([directoryWith({ 'QQ.json': VALID })], [QQ]).get(QQ)?.inventory,
      ).toBeUndefined();
    });

    it.each([1, 4])('carries the source limit %i', (limit) => {
      const loaded = loadMarketConfigs([withInventory({ maxSourcesPerSeller: limit })], [QQ]).get(
        QQ,
      );

      expect(loaded?.inventory?.maxSourcesPerSeller).toBe(limit);
    });

    it('gives the two Market fixtures different limits (AC 13)', () => {
      const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
      const limits = TEST_MARKET_IDS.map((id) => configs.get(id)?.inventory?.maxSourcesPerSeller);

      expect(Object.fromEntries(TEST_MARKET_IDS.map((id, i) => [id, limits[i]]))).toEqual({
        AU: 4,
        ZZ: 2,
      });
    });

    it.each([
      ['a missing limit', {}],
      ['zero sources', { maxSourcesPerSeller: 0 }],
      ['more sources than the re-key lock set allows', { maxSourcesPerSeller: 5 }],
      ['a negative limit', { maxSourcesPerSeller: -1 }],
      ['a null limit', { maxSourcesPerSeller: null }],
      ['a string limit', { maxSourcesPerSeller: '4' }],
      ['a fractional limit', { maxSourcesPerSeller: 2.5 }],
      ['an unknown key', { maxSourcesPerSeller: 4, reservationMinutes: 15 }],
    ])('rejects %s', (_case, inventory) => {
      expect(() => loadMarketConfigs([withInventory(inventory)], [QQ])).toThrow(
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
