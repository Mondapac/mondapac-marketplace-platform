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
  pricesIncludeTax: true,
  maxLineQuantity: 99,
  timezone: 'Pacific/Auckland',
  requestLimits: { anonymousIdentityPerMinute: 20, defaultPerMinute: 300 },
  allowedOrigins: {
    admin: ['https://admin.qq.test'],
    seller: ['https://seller.qq.test'],
    customer: ['https://shop.qq.test'],
  },
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
      { allowedOrigins: { ...VALID.allowedOrigins, customer: ['https://shop.qq.test/'] } },
      /allowedOrigins\.customer\.0/,
    ],
    [
      'an allowed origin that is not http(s)',
      { allowedOrigins: { ...VALID.allowedOrigins, customer: ['ftp://shop.qq.test'] } },
      /allowedOrigins\.customer/,
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
    // A non-empty customer list holds the origin of every customer link page.
    const customer = [...new Set(['https://shop.qq.test', new URL(page).origin])];
    const allowedOrigins = { ...VALID.allowedOrigins, customer };
    const directory = directoryWith({ 'QQ.json': { ...VALID, allowedOrigins, identity } });

    expect(loadMarketConfigs([directory], [QQ]).get(QQ)!.identity.links).toEqual(identity.links);
  });

  describe('allowedOrigins per population (identity design 6.4, HF14; Ali 2026-10-08)', () => {
    const WITH_PANELS = {
      ...VALID,
      identity: {
        ...IDENTITY,
        links: {
          ...IDENTITY.links,
          targets: {
            ...IDENTITY.links.targets,
            seller: {
              'verify-email': 'https://seller.qq.test/confirm-email',
              'sign-in': 'https://seller.qq.test/sign-in',
              'reset-password': 'https://seller.qq.test/reset-password',
            },
            admin: { 'seller-review-queue': 'https://admin.qq.test/sellers/awaiting-review' },
          },
        },
      },
    };
    const ORIGINS = WITH_PANELS.allowedOrigins;
    const load = (config: object) =>
      loadMarketConfigs([directoryWith({ 'QQ.json': config })], [QQ]).get(QQ)!;
    const withOrigins = (allowedOrigins: unknown) => ({ ...WITH_PANELS, allowedOrigins });

    it('accepts one list per population, matching the link pages', () => {
      expect(load(WITH_PANELS).allowedOrigins).toEqual(ORIGINS);
    });

    it('accepts three empty lists (fail closed, AU until D2)', () => {
      const empty = { admin: [], seller: [], customer: [] };

      expect(load(withOrigins(empty)).allowedOrigins).toEqual(empty);
    });

    it('configures both test Markets: AU fails closed, ZZ lists its link-page hosts', () => {
      const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

      expect(markets.get(testMarketId('AU'))!.allowedOrigins).toEqual({
        admin: [],
        seller: [],
        customer: [],
      });
      expect(markets.get(testMarketId('ZZ'))!.allowedOrigins).toEqual({
        admin: ['https://admin.zz.test'],
        seller: ['https://seller.zz.test'],
        customer: ['https://storefront.zz.test'],
      });
      for (const market of markets.values()) {
        for (const population of ['admin', 'seller', 'customer'] as const) {
          const list = market.allowedOrigins[population];
          if (list.length === 0) continue;
          const pages = Object.values<string>(market.identity.links.targets[population] ?? {});
          for (const page of pages) expect(list).toContain(new URL(page).origin);
        }
      }
    });

    it.each([
      'http://localhost:3001',
      'http://seller.localhost:3001',
      'http://127.0.0.1:3001',
      'http://[::1]:3001',
    ])('accepts the loopback origin %s on plain http', (origin) => {
      const config = withOrigins({ ...ORIGINS, customer: [...ORIGINS.customer, origin] });

      expect(load(config).allowedOrigins.customer).toContain(origin);
    });

    it.each([
      ['a flat list (the old shape)', ['https://shop.qq.test'], /allowedOrigins/],
      ['a missing population', { admin: [], seller: [] }, /allowedOrigins\.customer/],
      ['an unknown population', { ...ORIGINS, staff: [] }, /allowedOrigins.*(staff|Unrecognized)/],
      [
        'a duplicate within a list',
        { ...ORIGINS, customer: ['https://shop.qq.test', 'https://shop.qq.test'] },
        /allowedOrigins\.customer\.1: an origin must not repeat/,
      ],
      [
        'more than 20 origins in a list',
        {
          ...ORIGINS,
          customer: [
            'https://shop.qq.test',
            ...Array.from({ length: 20 }, (_, n) => `https://shop${n}.qq.test`),
          ],
        },
        /allowedOrigins\.customer/,
      ],
      [
        'plain http to a non-loopback host',
        { ...ORIGINS, customer: ['https://shop.qq.test', 'http://shop2.qq.test'] },
        /allowedOrigins\.customer\.1/,
      ],
      [
        'an origin with credentials',
        { ...ORIGINS, customer: ['https://shop.qq.test', 'https://a:b@shop2.qq.test'] },
        /allowedOrigins\.customer\.1/,
      ],
      [
        'an admin origin equal to a seller origin',
        { ...ORIGINS, seller: ['https://seller.qq.test', 'https://admin.qq.test'] },
        /allowedOrigins\.admin\.0: an origin must not share its host name with another population's origin/,
      ],
      [
        'an admin origin equal to a customer origin',
        { ...ORIGINS, customer: ['https://shop.qq.test', 'https://admin.qq.test'] },
        /allowedOrigins\.admin\.0: an origin must not share its host name with another population's origin/,
      ],
      [
        'an admin host equal to a seller host on another port',
        { ...ORIGINS, admin: ['https://admin.qq.test', 'https://seller.qq.test:8443'] },
        /allowedOrigins\.admin\.1: an origin must not share its host name with another population's origin/,
      ],
      [
        'an admin host equal to a customer host on another scheme and port (loopback)',
        {
          admin: ['https://admin.qq.test', 'http://localhost:3002'],
          seller: ORIGINS.seller,
          customer: ['https://shop.qq.test', 'http://localhost:3000'],
        },
        /allowedOrigins\.admin\.1: an origin must not share its host name/,
      ],
      [
        'a seller host equal to a customer host on another port (Ali ruling 1)',
        { ...ORIGINS, customer: ['https://shop.qq.test', 'https://seller.qq.test:8443'] },
        /allowedOrigins\.seller\.0: an origin must not share its host name with another population's origin/,
      ],
    ])('rejects %s', (_case, allowedOrigins, message) => {
      expect(() => load(withOrigins(allowedOrigins))).toThrow(InvalidMarketConfigError);
      expect(() => load(withOrigins(allowedOrigins))).toThrow(message);
    });

    it.each([
      ['admin', { ...ORIGINS, admin: ['https://ops.qq.test'] }, 'https://admin.qq.test'],
      ['seller', { ...ORIGINS, seller: ['https://panel.qq.test'] }, 'https://seller.qq.test'],
      ['customer', { ...ORIGINS, customer: ['https://www.qq.test'] }, 'https://shop.qq.test'],
    ] as const)(
      'rejects a non-empty %s list without the origin of its link pages',
      (population, allowedOrigins, missing) => {
        expect(() => load(withOrigins(allowedOrigins))).toThrow(
          `allowedOrigins.${population}: must hold the origin of every ${population} link page (${missing})`,
        );
      },
    );

    it.each([
      [
        'an admin origin on a seller link host',
        { admin: ['https://admin.qq.test', 'https://seller.qq.test:9443'] },
        'admin.1',
      ],
      [
        'an admin origin on a customer link host',
        { admin: ['https://admin.qq.test', 'https://shop.qq.test:9443'] },
        'admin.1',
      ],
      [
        'a seller origin on the admin link host',
        { seller: ['https://seller.qq.test', 'https://admin.qq.test:9443'] },
        'seller.1',
      ],
      [
        'a customer origin on a seller link host',
        { customer: ['https://shop.qq.test', 'https://seller.qq.test:9443'] },
        'customer.1',
      ],
    ])('rejects %s (Hassan Low 2)', (_case, lists, path) => {
      const allowedOrigins = { ...ORIGINS, ...lists };

      expect(() => load(withOrigins(allowedOrigins))).toThrow(
        `allowedOrigins.${path}: an origin must not share its host name with another population's link page`,
      );
    });

    it.each([
      ['seller', 'customer'],
      ['admin', 'customer'],
      ['admin', 'seller'],
    ] as const)(
      'rejects a %s host equal to a %s host on another port, without any link page on it',
      (later, earlier) => {
        // VALID has customer link pages only, so only the lists themselves are compared here.
        const allowedOrigins = {
          admin: [] as string[],
          seller: [] as string[],
          customer: [] as string[],
          [earlier]: ['https://shared.qq.test'],
          [later]: ['https://shared.qq.test:8443'],
        };
        if (earlier === 'customer') allowedOrigins.customer.push('https://shop.qq.test');

        expect(() => load({ ...VALID, allowedOrigins })).toThrow(
          `allowedOrigins.${later}.0: an origin must not share its host name with another population's origin`,
        );
      },
    );

    it("rejects an empty list's neighbour sharing a link host even when the own list is empty", () => {
      const allowedOrigins = {
        admin: [],
        seller: [],
        customer: ['https://shop.qq.test', 'https://admin.qq.test'],
      };

      expect(() => load(withOrigins(allowedOrigins))).toThrow(
        "allowedOrigins.customer.1: an origin must not share its host name with another population's link page",
      );
    });
  });

  describe('the admin link targets (identity design 8.7, the reviewer notice)', () => {
    const SELLER_PAGES = {
      'verify-email': 'https://seller.qq.test/confirm-email',
      'sign-in': 'https://seller.qq.test/sign-in',
      'reset-password': 'https://seller.qq.test/reset-password',
    };
    const QUEUE = 'https://admin.qq.test/sellers/awaiting-review';

    function withTargets(targets: Record<string, unknown>) {
      return {
        ...VALID,
        identity: {
          ...IDENTITY,
          links: { ...IDENTITY.links, targets: { ...IDENTITY.links.targets, ...targets } },
        },
      };
    }

    it('configures the review queue page for both test Markets, on an origin of its own', () => {
      const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

      for (const market of markets.values()) {
        const { admin, seller, customer } = market.identity.links.targets;
        expect(admin?.['seller-review-queue']).toMatch(/^https:\/\//);
        const queueOrigin = new URL(admin!['seller-review-queue']).origin;
        for (const page of [...Object.values(seller ?? {}), ...Object.values(customer)]) {
          expect(new URL(page).origin).not.toBe(queueOrigin);
        }
      }
    });

    it('accepts seller targets together with the admin review queue page', () => {
      const directory = directoryWith({
        'QQ.json': withTargets({ seller: SELLER_PAGES, admin: { 'seller-review-queue': QUEUE } }),
      });

      expect(loadMarketConfigs([directory], [QQ]).get(QQ)!.identity.links.targets.admin).toEqual({
        'seller-review-queue': QUEUE,
      });
    });

    it('accepts a Market without seller sign-up and without admin targets', () => {
      const directory = directoryWith({ 'QQ.json': VALID });

      expect(
        loadMarketConfigs([directory], [QQ]).get(QQ)!.identity.links.targets.admin,
      ).toBeUndefined();
    });

    it.each([
      [
        'seller targets without the admin review queue page (boot fails, not a mail)',
        { seller: SELLER_PAGES },
        /identity\.links\.targets\.admin: admin\.seller-review-queue is required/,
      ],
      [
        'an admin targets section without the review queue page',
        { seller: SELLER_PAGES, admin: {} },
        /identity\.links\.targets\.admin\.seller-review-queue/,
      ],
      [
        'the review queue page under the seller population (admin only)',
        { seller: { ...SELLER_PAGES, 'seller-review-queue': QUEUE } },
        /identity\.links\.targets\.seller/,
      ],
      [
        'the review queue page under the customer population (admin only)',
        { customer: { ...IDENTITY.links.targets.customer, 'seller-review-queue': QUEUE } },
        /identity\.links\.targets\.customer/,
      ],
      [
        'a seller page under the admin population',
        { seller: SELLER_PAGES, admin: { 'seller-review-queue': QUEUE, 'verify-email': QUEUE } },
        /identity\.links\.targets\.admin/,
      ],
      [
        'an admin page on the seller panel origin (Hassan I1)',
        {
          seller: SELLER_PAGES,
          admin: { 'seller-review-queue': 'https://seller.qq.test/admin/queue' },
        },
        /identity\.links\.targets\.admin\.seller-review-queue: an admin page must not share its origin/,
      ],
      [
        'an admin page on the storefront origin (Hassan I1)',
        { seller: SELLER_PAGES, admin: { 'seller-review-queue': 'https://shop.qq.test/queue' } },
        /identity\.links\.targets\.admin\.seller-review-queue: an admin page must not share its origin/,
      ],
      [
        'an admin page on the seller host under another port (Hassan I-1)',
        {
          seller: SELLER_PAGES,
          admin: { 'seller-review-queue': 'https://seller.qq.test:8443/admin/queue' },
        },
        /identity\.links\.targets\.admin\.seller-review-queue: an admin page must not share its host name/,
      ],
      [
        'an admin page on a loopback storefront host under another port (Hassan I-1)',
        {
          customer: {
            'verify-email': 'http://localhost:3001/confirm-email',
            'sign-in': 'http://localhost:3001/sign-in',
            'reset-password': 'http://localhost:3001/reset-password',
          },
          seller: SELLER_PAGES,
          admin: { 'seller-review-queue': 'http://localhost:3002/queue' },
        },
        /identity\.links\.targets\.admin\.seller-review-queue: an admin page must not share its host name/,
      ],
      [
        'an admin page with a fragment',
        { seller: SELLER_PAGES, admin: { 'seller-review-queue': 'https://admin.qq.test/q#x' } },
        /identity\.links\.targets\.admin\.seller-review-queue/,
      ],
      [
        'an admin page over plain http on a public host',
        { seller: SELLER_PAGES, admin: { 'seller-review-queue': 'http://admin.qq.test/q' } },
        /identity\.links\.targets\.admin\.seller-review-queue/,
      ],
    ])('rejects %s', (_case, targets, message) => {
      const directory = directoryWith({ 'QQ.json': withTargets(targets) });

      expect(() => loadMarketConfigs([directory], [QQ])).toThrow(InvalidMarketConfigError);
      expect(() => loadMarketConfigs([directory], [QQ])).toThrow(message);
    });
  });

  describe('the admin sign-in keys (identity slice 7b; identity design 6.1, 6.6, 6.8)', () => {
    const ADMIN_PAGES = {
      'seller-review-queue': 'https://admin.qq.test/sellers/awaiting-review',
      'sign-in': 'https://admin.qq.test/sign-in',
      'accept-invitation': 'https://admin.qq.test/accept-invitation',
      'enrol-second-factor': 'https://admin.qq.test/second-factor/enrol',
      'reset-password': 'https://admin.qq.test/reset-password',
    };
    /** A Market with admin sign-in configured whole, at Hassan's ceilings. */
    const ADMIN_IDENTITY = {
      ...IDENTITY,
      sessions: {
        ...IDENTITY.sessions,
        admin: { idleTimeoutMinutes: 30, absoluteLifetimeMinutes: 720 },
      },
      links: {
        lifetimeMinutes: { ...IDENTITY.links.lifetimeMinutes, 'enrol-second-factor': 60 },
        targets: { ...IDENTITY.links.targets, admin: ADMIN_PAGES },
      },
      invitations: { lifetimeMinutes: { admin: 4320, 'seller-owner': 10080, staff: 10080 } },
      challenges: { maxAttempts: 5, lifetimeSeconds: 300 },
      secondFactorThrottles: {
        account: { limit: 10, windowMinutes: 1440, blockMinutes: 1440 },
      },
    };
    type Node = Record<string, unknown>;
    const load = (identity: Node) =>
      loadMarketConfigs([directoryWith({ 'QQ.json': { ...VALID, identity } })], [QQ]).get(QQ)!
        .identity;
    const change = (edit: (copy: Node) => void): Node => {
      const copy = structuredClone(ADMIN_IDENTITY) as Node;
      edit(copy);
      return copy;
    };
    const at = (copy: Node, ...keys: string[]): Node =>
      keys.reduce((node, key) => node[key] as Node, copy);

    it('carries the AU values of identity design 6.1, 6.6 and 6.8, and other valid values for ZZ', () => {
      const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
      const au = markets.get(testMarketId('AU'))!.identity;
      const zz = markets.get(testMarketId('ZZ'))!.identity;

      expect(au.sessions.admin).toEqual({ idleTimeoutMinutes: 30, absoluteLifetimeMinutes: 720 });
      expect(au.links.lifetimeMinutes['enrol-second-factor']).toBe(60);
      expect(au.invitations).toEqual({
        lifetimeMinutes: { admin: 72 * 60, 'seller-owner': 7 * 24 * 60, staff: 7 * 24 * 60 },
      });
      expect(au.challenges).toEqual({ maxAttempts: 5, lifetimeSeconds: 300 });
      expect(au.secondFactorThrottles).toEqual({
        account: { limit: 10, windowMinutes: 24 * 60, blockMinutes: 24 * 60 },
      });
      for (const identity of [au, zz]) {
        expect(Object.keys(identity.links.targets.admin!).sort()).toEqual(
          Object.keys(ADMIN_PAGES).sort(),
        );
      }
      // ZZ differs in every value, so nothing passes only for AU.
      expect(zz.sessions.admin!.idleTimeoutMinutes).not.toBe(au.sessions.admin!.idleTimeoutMinutes);
      expect(zz.sessions.admin!.absoluteLifetimeMinutes).not.toBe(
        au.sessions.admin!.absoluteLifetimeMinutes,
      );
      expect(zz.links.lifetimeMinutes['enrol-second-factor']).not.toBe(
        au.links.lifetimeMinutes['enrol-second-factor'],
      );
      for (const kind of ['admin', 'seller-owner', 'staff'] as const) {
        expect(zz.invitations!.lifetimeMinutes[kind]).not.toBe(
          au.invitations!.lifetimeMinutes[kind],
        );
      }
      expect(zz.challenges!.maxAttempts).not.toBe(au.challenges!.maxAttempts);
      expect(zz.challenges!.lifetimeSeconds).not.toBe(au.challenges!.lifetimeSeconds);
      for (const field of ['limit', 'windowMinutes', 'blockMinutes'] as const) {
        expect(zz.secondFactorThrottles!.account[field]).not.toBe(
          au.secondFactorThrottles!.account[field],
        );
      }
    });

    it('accepts admin sign-in configured whole, at the ceilings, and a Market without it', () => {
      expect(load(ADMIN_IDENTITY)).toEqual(ADMIN_IDENTITY);
      const without = load(IDENTITY);
      expect(without.sessions.admin).toBeUndefined();
      expect(without.invitations).toBeUndefined();
      expect(without.challenges).toBeUndefined();
      expect(without.secondFactorThrottles).toBeUndefined();
    });

    it.each<[string, (copy: Node) => void, RegExp]>([
      [
        'an admin session idle for more than 30 minutes',
        (c) => (at(c, 'sessions', 'admin').idleTimeoutMinutes = 31),
        /identity\.sessions\.admin\.idleTimeoutMinutes/,
      ],
      [
        'an admin session of more than 12 hours',
        (c) => (at(c, 'sessions', 'admin').absoluteLifetimeMinutes = 721),
        /identity\.sessions\.admin\.absoluteLifetimeMinutes/,
      ],
      [
        'an admin session idle longer than its absolute lifetime',
        (c) => (at(c, 'sessions').admin = { idleTimeoutMinutes: 30, absoluteLifetimeMinutes: 20 }),
        /identity\.sessions\.admin\.idleTimeoutMinutes/,
      ],
      [
        '"keep me signed in" for the admin population (an admin session is never persistent)',
        (c) =>
          (c.keepSignedInSessions = {
            admin: { idleTimeoutMinutes: 30, absoluteLifetimeMinutes: 720 },
          }),
        /identity\.keepSignedInSessions/,
      ],
      [
        'an enrolment link of more than 60 minutes',
        (c) => (at(c, 'links', 'lifetimeMinutes')['enrol-second-factor'] = 61),
        /identity\.links\.lifetimeMinutes\.enrol-second-factor/,
      ],
      [
        'an enrolment link of 0 minutes',
        (c) => (at(c, 'links', 'lifetimeMinutes')['enrol-second-factor'] = 0),
        /identity\.links\.lifetimeMinutes\.enrol-second-factor/,
      ],
      [
        'an admin invitation of more than 72 hours (HF15)',
        (c) => (at(c, 'invitations', 'lifetimeMinutes').admin = 72 * 60 + 1),
        /identity\.invitations\.lifetimeMinutes\.admin/,
      ],
      [
        'a seller-owner invitation of more than 7 days',
        (c) => (at(c, 'invitations', 'lifetimeMinutes')['seller-owner'] = 10_081),
        /identity\.invitations\.lifetimeMinutes\.seller-owner/,
      ],
      [
        'a staff invitation of more than 7 days',
        (c) => (at(c, 'invitations', 'lifetimeMinutes').staff = 10_081),
        /identity\.invitations\.lifetimeMinutes\.staff/,
      ],
      [
        'an invitation kind that does not exist',
        (c) => (at(c, 'invitations', 'lifetimeMinutes').customer = 60),
        /identity\.invitations\.lifetimeMinutes/,
      ],
      [
        'a challenge of more than 5 attempts',
        (c) => (at(c, 'challenges').maxAttempts = 6),
        /identity\.challenges\.maxAttempts/,
      ],
      [
        'a challenge of 0 attempts',
        (c) => (at(c, 'challenges').maxAttempts = 0),
        /identity\.challenges\.maxAttempts/,
      ],
      [
        'a challenge of more than 5 minutes',
        (c) => (at(c, 'challenges').lifetimeSeconds = 301),
        /identity\.challenges\.lifetimeSeconds/,
      ],
      [
        'a challenge of less than 30 seconds',
        (c) => (at(c, 'challenges').lifetimeSeconds = 29),
        /identity\.challenges\.lifetimeSeconds/,
      ],
      [
        'more than 10 failed codes before the lock (HF2)',
        (c) => (at(c, 'secondFactorThrottles', 'account').limit = 11),
        /identity\.secondFactorThrottles\.account\.limit/,
      ],
      [
        'a second-factor window shorter than 24 hours',
        (c) => (at(c, 'secondFactorThrottles', 'account').windowMinutes = 1439),
        /identity\.secondFactorThrottles\.account\.windowMinutes/,
      ],
      [
        'a second-factor block of 0 (the block is the lock)',
        (c) => (at(c, 'secondFactorThrottles', 'account').blockMinutes = 0),
        /identity\.secondFactorThrottles\.account\.blockMinutes/,
      ],
      [
        'a second-factor block longer than 7 days',
        (c) => (at(c, 'secondFactorThrottles', 'account').blockMinutes = 10_081),
        /identity\.secondFactorThrottles\.account\.blockMinutes/,
      ],
      [
        'an admin session without the challenge policy',
        (c) => delete c.challenges,
        /identity\.sessions\.admin: sessions\.admin needs challenges/,
      ],
      [
        'an admin session without the second-factor counter',
        (c) => delete c.secondFactorThrottles,
        /identity\.sessions\.admin: sessions\.admin needs secondFactorThrottles/,
      ],
      [
        'an admin session without the enrolment link lifetime',
        (c) => delete at(c, 'links', 'lifetimeMinutes')['enrol-second-factor'],
        /sessions\.admin needs links\.lifetimeMinutes\.enrol-second-factor/,
      ],
      [
        'an admin session without the admin invitation lifetime',
        (c) => delete at(c, 'invitations', 'lifetimeMinutes').admin,
        /sessions\.admin needs invitations\.lifetimeMinutes\.admin/,
      ],
      [
        'an admin session without the admin sign-in pages',
        (c) =>
          (at(c, 'links', 'targets').admin = {
            'seller-review-queue': ADMIN_PAGES['seller-review-queue'],
          }),
        /sessions\.admin needs links\.targets\.admin\.sign-in/,
      ],
      [
        'an admin sign-in page on the storefront origin (Hassan I1)',
        (c) => (at(c, 'links', 'targets', 'admin')['sign-in'] = 'https://shop.qq.test/admin'),
        /identity\.links\.targets\.admin\.sign-in: an admin page must not share its origin/,
      ],
      [
        'an admin sign-in page with a fragment',
        (c) =>
          (at(c, 'links', 'targets', 'admin')['accept-invitation'] = 'https://admin.qq.test/a#x'),
        /identity\.links\.targets\.admin\.accept-invitation/,
      ],
    ])('rejects %s', (_case, edit, message) => {
      const identity = change(edit);
      expect(() => load(identity)).toThrow(InvalidMarketConfigError);
      expect(() => load(identity)).toThrow(message);
    });

    const SIGN_IN_PAGES = [
      'sign-in',
      'accept-invitation',
      'enrol-second-factor',
      'reset-password',
    ] as const;

    it.each(SIGN_IN_PAGES)(
      'rejects the admin sign-in pages without %s (all four or none)',
      (page) => {
        const identity = change((c) => delete at(c, 'links', 'targets', 'admin')[page]);
        expect(() => load(identity)).toThrow(
          /identity\.links\.targets\.admin: admin pages sign-in, accept-invitation, enrol-second-factor, reset-password are given together/,
        );
      },
    );

    // Hassan, PR #157: an admin token is only ever mailed to the origin of the admin panel.
    it.each(
      SIGN_IN_PAGES.flatMap((page) => [
        [page, 'a foreign host', 'https://evil.example/admin/page'],
        [page, 'another port of the admin host', 'https://admin.qq.test:8443/page'],
      ]),
    )('rejects the admin page %s on %s', (page, _case, url) => {
      const identity = change((c) => (at(c, 'links', 'targets', 'admin')[page] = url));
      expect(() => load(identity)).toThrow(
        new RegExp(
          `identity\\.links\\.targets\\.admin\\.${page}: an admin page must have the origin of seller-review-queue`,
        ),
      );
    });

    it('rejects every admin sign-in page when the review queue moves to another origin', () => {
      const identity = change(
        (c) =>
          (at(c, 'links', 'targets', 'admin')['seller-review-queue'] =
            'https://admin.qq.test:9443/sellers/awaiting-review'),
      );
      for (const page of SIGN_IN_PAGES) {
        expect(() => load(identity)).toThrow(
          new RegExp(`identity\\.links\\.targets\\.admin\\.${page}: an admin page must have`),
        );
      }
    });

    // Sajad, PR #157: each numeric key at its bounds, the value outside refused and the bound
    // itself accepted.
    it.each<[string, string[], number, number, ((c: Node) => void)?]>([
      ['the admin idle timeout', ['sessions', 'admin', 'idleTimeoutMinutes'], 0, 1],
      [
        'the admin absolute lifetime',
        ['sessions', 'admin', 'absoluteLifetimeMinutes'],
        0,
        1,
        (c) => (at(c, 'sessions', 'admin').idleTimeoutMinutes = 1),
      ],
      ['the enrolment link', ['links', 'lifetimeMinutes', 'enrol-second-factor'], 0, 1],
      ['the admin invitation', ['invitations', 'lifetimeMinutes', 'admin'], 0, 1],
      ['the seller-owner invitation', ['invitations', 'lifetimeMinutes', 'seller-owner'], 0, 1],
      ['the staff invitation', ['invitations', 'lifetimeMinutes', 'staff'], 0, 1],
      ['the challenge attempts', ['challenges', 'maxAttempts'], 0, 1],
      ['the challenge lifetime', ['challenges', 'lifetimeSeconds'], 29, 30],
      ['the second-factor limit', ['secondFactorThrottles', 'account', 'limit'], 0, 1],
      [
        'the second-factor window (lower bound)',
        ['secondFactorThrottles', 'account', 'windowMinutes'],
        1439,
        1440,
      ],
      [
        'the second-factor window (upper bound)',
        ['secondFactorThrottles', 'account', 'windowMinutes'],
        10_081,
        10_080,
      ],
      [
        'the second-factor block (lower bound)',
        ['secondFactorThrottles', 'account', 'blockMinutes'],
        1439,
        1440,
      ],
      [
        'the second-factor block (upper bound)',
        ['secondFactorThrottles', 'account', 'blockMinutes'],
        10_081,
        10_080,
      ],
    ])('bounds %s', (...[, keys, refused, accepted, prepare]) => {
      // A rest parameter: Jest would take a fifth named parameter for a done callback.
      const parent = keys.slice(0, -1);
      const key = keys.at(-1)!;
      const valued = (value: number) =>
        change((c) => {
          prepare?.(c);
          at(c, ...parent)[key] = value;
        });
      const pattern = new RegExp(`identity\\.${keys.join('\\.')}`);

      expect(() => load(valued(refused))).toThrow(InvalidMarketConfigError);
      expect(() => load(valued(refused))).toThrow(pattern);
      expect(at(load(valued(accepted)) as unknown as Node, ...parent)[key]).toBe(accepted);
    });

    describe('the 1-B guard: "keep me signed in" lasts longer than the default seller session', () => {
      const withSeller = (keptAbsolute: number) => ({
        ...IDENTITY,
        sessions: {
          ...IDENTITY.sessions,
          seller: { idleTimeoutMinutes: 720, absoluteLifetimeMinutes: 1440 },
        },
        keepSignedInSessions: {
          seller: { idleTimeoutMinutes: 720, absoluteLifetimeMinutes: keptAbsolute },
        },
        links: {
          ...IDENTITY.links,
          targets: {
            ...IDENTITY.links.targets,
            seller: {
              'verify-email': 'https://seller.qq.test/confirm-email',
              'sign-in': 'https://seller.qq.test/sign-in',
              'reset-password': 'https://seller.qq.test/reset-password',
            },
            admin: { 'seller-review-queue': 'https://admin.qq.test/queue' },
          },
        },
      });

      it.each([
        ['equal to', 1440],
        ['lower than', 1439],
      ])('rejects a kept absolute lifetime %s the default one', (_case, kept) => {
        expect(() => load(withSeller(kept))).toThrow(
          /identity\.keepSignedInSessions\.seller\.absoluteLifetimeMinutes: keepSignedInSessions\.seller\.absoluteLifetimeMinutes must be greater than sessions\.seller\.absoluteLifetimeMinutes/,
        );
      });

      it('accepts a kept absolute lifetime greater than the default one', () => {
        expect(load(withSeller(1441)).keepSignedInSessions.seller!.absoluteLifetimeMinutes).toBe(
          1441,
        );
        expect(load(withSeller(43_200)).keepSignedInSessions.seller!.absoluteLifetimeMinutes).toBe(
          43_200,
        );
      });

      it('holds for both Market fixtures', () => {
        const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
        for (const market of markets.values()) {
          const { sessions, keepSignedInSessions } = market.identity;
          expect(keepSignedInSessions.seller!.absoluteLifetimeMinutes).toBeGreaterThan(
            sessions.seller!.absoluteLifetimeMinutes,
          );
        }
      });
    });
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
      reservedWords: { slugs: ['admin'], claimWords: ['gold'] },
      businessIdentifier: { scheme: 'nz-nzbn', required: false, labelKey: 'k.identifier' },
      registerLookup: {
        adapter: 'none',
        manualLinkTemplate: 'https://register.example.test/find/{identifier}',
        maxResultAgeDays: 30,
        perAccountLimit: 5,
        perOriginLimit: 30,
        marketDailyBudget: 1000,
        legalSuffixes: ['ltd', 'limited'],
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

    it('has a different register adapter and different limits in the two Market fixtures', () => {
      const [first, second] = [
        ...loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS).values(),
      ];

      expect(first?.sellers?.registerLookup.adapter).not.toBe(
        second?.sellers?.registerLookup.adapter,
      );
      expect(first?.sellers?.registerLookup.marketDailyBudget).not.toBe(
        second?.sellers?.registerLookup.marketDailyBudget,
      );
      expect(first?.sellers?.registerLookup.legalSuffixes).not.toEqual(
        second?.sellers?.registerLookup.legalSuffixes,
      );
    });

    it('lists different reserved words in the two Market fixtures', () => {
      const [first, second] = [
        ...loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS).values(),
      ];

      expect(first?.sellers?.reservedWords.claimWords.length).toBeGreaterThan(0);
      expect(first?.sellers?.reservedWords.claimWords).not.toEqual(
        second?.sellers?.reservedWords.claimWords,
      );
    });

    it('has a different identifier scheme and requirement in the two Market fixtures', () => {
      const [first, second] = [
        ...loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS).values(),
      ];

      expect(first?.sellers?.businessIdentifier.scheme).not.toBe(
        second?.sellers?.businessIdentifier.scheme,
      );
      expect(first?.sellers?.businessIdentifier.required).not.toBe(
        second?.sellers?.businessIdentifier.required,
      );
      expect(first?.sellers?.businessIdentifier.labelKey).not.toBe(
        second?.sellers?.businessIdentifier.labelKey,
      );
    });

    it.each([
      [
        'no identifier section: a Market never defaults its scheme',
        (c: typeof SELLERS) =>
          void delete (c as { businessIdentifier?: unknown }).businessIdentifier,
        /businessIdentifier/,
      ],
      [
        'a scheme with upper case',
        (c: typeof SELLERS) => void (c.businessIdentifier.scheme = 'ABN'),
        /lower-case scheme token/,
      ],
      [
        'a scheme with a double hyphen',
        (c: typeof SELLERS) => void (c.businessIdentifier.scheme = 'a--b'),
        /lower-case scheme token/,
      ],
      [
        'a scheme that starts with a digit',
        (c: typeof SELLERS) => void (c.businessIdentifier.scheme = '1abn'),
        /lower-case scheme token/,
      ],
      [
        'a scheme longer than 32 characters',
        (c: typeof SELLERS) => void (c.businessIdentifier.scheme = 'a'.repeat(33)),
        /too big|<=32/,
      ],
      [
        'no required flag',
        (c: typeof SELLERS) =>
          void delete (c.businessIdentifier as { required?: boolean }).required,
        /required/,
      ],
      [
        'an empty label key',
        (c: typeof SELLERS) => void (c.businessIdentifier.labelKey = ''),
        /labelKey/,
      ],
      [
        'an empty scheme',
        (c: typeof SELLERS) => void (c.businessIdentifier.scheme = ''),
        /lower-case scheme token|scheme/,
      ],
      [
        'a scheme with a trailing hyphen',
        (c: typeof SELLERS) => void (c.businessIdentifier.scheme = 'abn-'),
        /lower-case scheme token/,
      ],
      [
        'a required flag that is not a boolean',
        (c: typeof SELLERS) =>
          void ((c.businessIdentifier as { required: unknown }).required = 'yes'),
        /required/,
      ],
      [
        'a label key longer than 64 characters',
        (c: typeof SELLERS) => void (c.businessIdentifier.labelKey = 'k'.repeat(65)),
        /too big|<=64|labelKey/,
      ],
      [
        'an unknown key in businessIdentifier',
        (c: typeof SELLERS) =>
          void ((c.businessIdentifier as Record<string, unknown>).extra = true),
        /unrecognized/i,
      ],
      [
        'no registerLookup: a Market never defaults its register',
        (c: typeof SELLERS) => void delete (c as { registerLookup?: unknown }).registerLookup,
        /registerLookup/,
      ],
      [
        'an adapter with upper case',
        (c: typeof SELLERS) => void (c.registerLookup.adapter = 'ABR'),
        /lower-case adapter token/,
      ],
      [
        'a manual link that is not https',
        (c: typeof SELLERS) =>
          void (c.registerLookup.manualLinkTemplate = 'http://r.example.test/{identifier}'),
        /https URL/,
      ],
      [
        'a manual link without the placeholder',
        (c: typeof SELLERS) =>
          void (c.registerLookup.manualLinkTemplate = 'https://r.example.test/find'),
        /https URL/,
      ],
      [
        'a manual link with the placeholder twice',
        (c: typeof SELLERS) =>
          void (c.registerLookup.manualLinkTemplate =
            'https://r.example.test/{identifier}/{identifier}'),
        /https URL/,
      ],
      [
        'a manual link whose host is the placeholder',
        (c: typeof SELLERS) =>
          void (c.registerLookup.manualLinkTemplate = 'https://{identifier}.example.test/'),
        /https URL/,
      ],
      [
        'a manual link with credentials',
        (c: typeof SELLERS) =>
          void (c.registerLookup.manualLinkTemplate =
            'https://user:pw@r.example.test/{identifier}'),
        /https URL/,
      ],
      [
        'a result age of zero days',
        (c: typeof SELLERS) => void (c.registerLookup.maxResultAgeDays = 0),
        /maxResultAgeDays|>=1/,
      ],
      [
        'a per-account limit that is not an integer',
        (c: typeof SELLERS) => void (c.registerLookup.perAccountLimit = 2.5),
        /perAccountLimit|integer/,
      ],
      [
        'a Market budget of zero',
        (c: typeof SELLERS) => void (c.registerLookup.marketDailyBudget = 0),
        /marketDailyBudget|>=1/,
      ],
      [
        'a legal suffix repeated',
        (c: typeof SELLERS) => void c.registerLookup.legalSuffixes.push('ltd'),
        /must not repeat an entry/,
      ],
      [
        'a legal suffix repeated in another case',
        (c: typeof SELLERS) => void c.registerLookup.legalSuffixes.push('LTD'),
        /must not repeat an entry/,
      ],
      [
        'a legal suffix with an angle bracket',
        (c: typeof SELLERS) => void c.registerLookup.legalSuffixes.push('<b>'),
        /printable text/,
      ],
      [
        'an adapter with a trailing hyphen',
        (c: typeof SELLERS) => void (c.registerLookup.adapter = 'abr-'),
        /lower-case adapter token/,
      ],
      [
        'an adapter longer than 32 characters',
        (c: typeof SELLERS) => void (c.registerLookup.adapter = 'a'.repeat(33)),
        /too big|<=32/,
      ],
      [
        'a manual link that is a javascript URL',
        (c: typeof SELLERS) =>
          void (c.registerLookup.manualLinkTemplate = 'javascript:alert(1)//{identifier}'),
        /https URL/,
      ],
      [
        'a manual link with a backslash',
        (c: typeof SELLERS) =>
          void (c.registerLookup.manualLinkTemplate = 'https://r.example.test\\{identifier}'),
        /https URL/,
      ],
      [
        'a manual link with a space',
        (c: typeof SELLERS) =>
          void (c.registerLookup.manualLinkTemplate = 'https://r.example.test/a b/{identifier}'),
        /https URL/,
      ],
      [
        'a manual link in upper-case scheme',
        (c: typeof SELLERS) =>
          void (c.registerLookup.manualLinkTemplate = 'HTTPS://r.example.test/{identifier}'),
        /https URL/,
      ],
      [
        'a manual link that is relative',
        (c: typeof SELLERS) => void (c.registerLookup.manualLinkTemplate = '/find/{identifier}'),
        /https URL/,
      ],
      [
        'a result age above a year',
        (c: typeof SELLERS) => void (c.registerLookup.maxResultAgeDays = 366),
        /maxResultAgeDays|<=365/,
      ],
      [
        'a limit given as text',
        (c: typeof SELLERS) =>
          void ((c.registerLookup as { perOriginLimit: unknown }).perOriginLimit = '30'),
        /perOriginLimit|number/,
      ],
      [
        'more than 50 legal suffixes',
        (c: typeof SELLERS) =>
          void (c.registerLookup.legalSuffixes = Array.from({ length: 51 }, (_, i) => `s${i}`)),
        /too big|<=50/,
      ],
      [
        'an unknown key in registerLookup',
        (c: typeof SELLERS) => void ((c.registerLookup as Record<string, unknown>).extra = 1),
        /unrecognized/i,
      ],
      [
        'no reserved words: a Market never defaults them',
        (c: typeof SELLERS) => void delete (c as { reservedWords?: unknown }).reservedWords,
        /reservedWords/,
      ],
      [
        'a hyphenated claim word, which could never match a token',
        (c: typeof SELLERS) => void c.reservedWords.claimWords.push('non-gmo'),
        /lower-case letters only/,
      ],
      [
        'an empty claim word list, which would switch the claim check off',
        (c: typeof SELLERS) => void (c.reservedWords.claimWords = []),
        /expected array to have >=1 items/,
      ],
      [
        'a repeated claim word',
        (c: typeof SELLERS) => void c.reservedWords.claimWords.push('gold'),
        /must not repeat an entry/,
      ],
      [
        'a repeated reserved slug',
        (c: typeof SELLERS) => void c.reservedWords.slugs.push('admin'),
        /must not repeat an entry/,
      ],
      [
        'a reserved slug longer than 50 characters',
        (c: typeof SELLERS) => void c.reservedWords.slugs.push('a'.repeat(51)),
        /too big|<=50/,
      ],
      [
        'an unknown key in reservedWords',
        (c: typeof SELLERS) => void ((c.reservedWords as Record<string, unknown>).extra = []),
        /unrecognized/i,
      ],
      [
        'a reserved word that is not a slug token',
        (c: typeof SELLERS) => void c.reservedWords.slugs.push('Not A Token'),
        /lower-case letters, digits and single hyphens/,
      ],
      [
        'a claim word with upper case',
        (c: typeof SELLERS) => void c.reservedWords.claimWords.push('Gold2'),
        /lower-case letters only/,
      ],
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

  describe('pricesIncludeTax and maxLineQuantity', () => {
    const load = (overrides: Record<string, unknown>) =>
      loadMarketConfigs([directoryWith({ 'QQ.json': { ...VALID, ...overrides } })], [QQ]).get(QQ);
    const without = (key: string) =>
      Object.fromEntries(Object.entries(VALID).filter(([name]) => name !== key));

    it('are read for each Market and differ between the two fixtures', () => {
      const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
      const read = TEST_MARKET_IDS.map((id) => [
        configs.get(id)?.pricesIncludeTax,
        configs.get(id)?.maxLineQuantity,
      ]);
      expect(read).toContainEqual([true, 99]);
      expect(read).toContainEqual([false, 50]);
    });

    it.each([1, 99, 999])('accepts a line ceiling of %s', (limit) => {
      expect(load({ maxLineQuantity: limit })?.maxLineQuantity).toBe(limit);
    });

    it('accepts a tax-exclusive Market', () => {
      expect(load({ pricesIncludeTax: false })?.pricesIncludeTax).toBe(false);
    });

    it.each([
      ['a zero ceiling', { maxLineQuantity: 0 }],
      ['a ceiling above 999', { maxLineQuantity: 1000 }],
      ['a negative ceiling', { maxLineQuantity: -1 }],
      ['a fractional ceiling', { maxLineQuantity: 2.5 }],
      ['a string ceiling', { maxLineQuantity: '99' }],
      ['a null ceiling', { maxLineQuantity: null }],
      ['a string convention', { pricesIncludeTax: 'true' }],
      ['a null convention', { pricesIncludeTax: null }],
    ])('rejects %s', (_case, overrides) => {
      expect(() => load(overrides)).toThrow(InvalidMarketConfigError);
    });

    it.each(['pricesIncludeTax', 'maxLineQuantity'])('requires %s, with no default', (key) => {
      expect(() => loadMarketConfigs([directoryWith({ 'QQ.json': without(key) })], [QQ])).toThrow(
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
      const loaded = loadMarketConfigs(
        [withInventory({ maxSourcesPerSeller: limit, defaultLowStockThreshold: 10 })],
        [QQ],
      ).get(QQ);

      expect(loaded?.inventory?.maxSourcesPerSeller).toBe(limit);
    });

    it('gives the two Market fixtures different thresholds (AC 13)', () => {
      const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
      const thresholds = TEST_MARKET_IDS.map(
        (id) => configs.get(id)?.inventory?.defaultLowStockThreshold,
      );

      expect(Object.fromEntries(TEST_MARKET_IDS.map((id, i) => [id, thresholds[i]]))).toEqual({
        AU: 10,
        ZZ: 3,
      });
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
      ['a missing limit', { defaultLowStockThreshold: 10 }],
      ['a missing threshold', { maxSourcesPerSeller: 4 }],
      ['zero sources', { maxSourcesPerSeller: 0, defaultLowStockThreshold: 10 }],
      [
        'more sources than the re-key lock set allows',
        { maxSourcesPerSeller: 5, defaultLowStockThreshold: 10 },
      ],
      ['a negative limit', { maxSourcesPerSeller: -1, defaultLowStockThreshold: 10 }],
      ['a null limit', { maxSourcesPerSeller: null, defaultLowStockThreshold: 10 }],
      ['a string limit', { maxSourcesPerSeller: '4', defaultLowStockThreshold: 10 }],
      ['a fractional limit', { maxSourcesPerSeller: 2.5, defaultLowStockThreshold: 10 }],
      ['a negative threshold', { maxSourcesPerSeller: 4, defaultLowStockThreshold: -1 }],
      ['a threshold above 99', { maxSourcesPerSeller: 4, defaultLowStockThreshold: 100 }],
      ['a fractional threshold', { maxSourcesPerSeller: 4, defaultLowStockThreshold: 2.5 }],
      ['a string threshold', { maxSourcesPerSeller: 4, defaultLowStockThreshold: '10' }],
      [
        'an unknown key',
        { maxSourcesPerSeller: 4, defaultLowStockThreshold: 10, reservationMinutes: 15 },
      ],
    ])('rejects %s', (_case, inventory) => {
      expect(() => loadMarketConfigs([withInventory(inventory)], [QQ])).toThrow(
        InvalidMarketConfigError,
      );
    });
  });

  describe('the pricing section', () => {
    const GOOD = {
      maxUnitPriceMinor: 500000,
      jumpThreshold: { numerator: 1, denominator: 2 },
      jumpDirections: 'both',
      jumpWindow: 'P7D',
    };
    const withPricing = (pricing: unknown) => directoryWith({ 'QQ.json': { ...VALID, pricing } });

    it('is optional for a Market that does not host pricing', () => {
      expect(
        loadMarketConfigs([directoryWith({ 'QQ.json': VALID })], [QQ]).get(QQ)?.pricing,
      ).toBeUndefined();
    });

    it('carries the policy values', () => {
      expect(loadMarketConfigs([withPricing(GOOD)], [QQ]).get(QQ)?.pricing).toEqual(GOOD);
    });

    it('gives the two Market fixtures different policies', () => {
      const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
      const directions = TEST_MARKET_IDS.map((id) => configs.get(id)?.pricing?.jumpDirections);

      expect(Object.fromEntries(TEST_MARKET_IDS.map((id, i) => [id, directions[i]]))).toEqual({
        AU: 'both',
        ZZ: 'up',
      });
    });

    it.each([
      ['a missing maximum', { ...GOOD, maxUnitPriceMinor: undefined }],
      ['a zero maximum', { ...GOOD, maxUnitPriceMinor: 0 }],
      ['an unsafe maximum', { ...GOOD, maxUnitPriceMinor: 2 ** 53 }],
      ['a string maximum', { ...GOOD, maxUnitPriceMinor: '500000' }],
      ['a threshold above one', { ...GOOD, jumpThreshold: { numerator: 3, denominator: 2 } }],
      ['a zero denominator', { ...GOOD, jumpThreshold: { numerator: 1, denominator: 0 } }],
      ['a decimal threshold', { ...GOOD, jumpThreshold: 0.5 }],
      ['an unknown direction', { ...GOOD, jumpDirections: 'sideways' }],
      ['a missing window', { ...GOOD, jumpWindow: undefined }],
      ['a window that is not a duration', { ...GOOD, jumpWindow: '7 days' }],
      ['an empty duration', { ...GOOD, jumpWindow: 'PT' }],
      ['a bare P', { ...GOOD, jumpWindow: 'P' }],
      ['an unknown key', { ...GOOD, specialsEnabled: true }],
    ])('rejects %s', (_case, pricing) => {
      expect(() => loadMarketConfigs([withPricing(pricing)], [QQ])).toThrow(
        InvalidMarketConfigError,
      );
    });
  });

  describe('the catalog section', () => {
    const VALID_CATALOG = {
      taxCategories: [{ code: 'standard', labelKey: 'catalog.tax.standard' }],
      sensitiveChanges: {
        platformCategories: true,
        taxCategory: true,
        name: true,
        primaryImage: true,
        anyImage: true,
        variantRemoved: true,
      },
      maxVariantsPerProduct: 100,
      approvalRequired: true,
      productTypes: ['simple', 'configurable'],
      defaultFamily: 'default',
    };
    const withCatalog = (catalog: unknown) => directoryWith({ 'QQ.json': { ...VALID, catalog } });

    it('is optional for a Market that does not host the catalog', () => {
      expect(
        loadMarketConfigs([directoryWith({ 'QQ.json': VALID })], [QQ]).get(QQ)?.catalog,
      ).toBeUndefined();
    });

    it('carries the section as written', () => {
      expect(loadMarketConfigs([withCatalog(VALID_CATALOG)], [QQ]).get(QQ)?.catalog).toEqual(
        VALID_CATALOG,
      );
    });

    it('gives the two Market fixtures different catalog settings', () => {
      const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
      const [au, zz] = TEST_MARKET_IDS.map((id) => configs.get(id)?.catalog);

      expect(au?.maxVariantsPerProduct).toBe(100);
      expect(zz?.maxVariantsPerProduct).toBe(3);
      expect(au?.approvalRequired).toBe(true);
      expect(zz?.approvalRequired).toBe(false);
      expect(au?.taxCategories.map((c) => c.code)).not.toEqual(
        zz?.taxCategories.map((c) => c.code),
      );
      expect(au?.sensitiveChanges.platformCategories).toBe(true);
      expect(zz?.sensitiveChanges.platformCategories).toBe(false);
    });

    const without = (key: string) => {
      const copy: Record<string, unknown> = { ...VALID_CATALOG };
      delete copy[key];
      return copy;
    };
    it.each([
      ['no tax category list', without('taxCategories')],
      ['an empty tax category list', { ...VALID_CATALOG, taxCategories: [] }],
      [
        'a repeated tax category code',
        {
          ...VALID_CATALOG,
          taxCategories: [
            { code: 'standard', labelKey: 'a' },
            { code: 'standard', labelKey: 'b' },
          ],
        },
      ],
      [
        'a tax category code with a capital',
        { ...VALID_CATALOG, taxCategories: [{ code: 'Standard', labelKey: 'a' }] },
      ],
      ['no sensitive changes', without('sensitiveChanges')],
      ['a missing sensitive flag', { ...VALID_CATALOG, sensitiveChanges: { name: true } }],
      [
        'a non-boolean sensitive flag',
        {
          ...VALID_CATALOG,
          sensitiveChanges: { ...VALID_CATALOG.sensitiveChanges, name: 'yes' },
        },
      ],
      [
        'anyImage switched off (an added image always goes to review)',
        {
          ...VALID_CATALOG,
          sensitiveChanges: { ...VALID_CATALOG.sensitiveChanges, anyImage: false },
        },
      ],
      ['no variant limit', without('maxVariantsPerProduct')],
      ['a zero variant limit', { ...VALID_CATALOG, maxVariantsPerProduct: 0 }],
      ['a variant limit above the lock set', { ...VALID_CATALOG, maxVariantsPerProduct: 101 }],
      ['a fractional variant limit', { ...VALID_CATALOG, maxVariantsPerProduct: 2.5 }],
      ['a string variant limit', { ...VALID_CATALOG, maxVariantsPerProduct: '100' }],
      ['no approval setting', without('approvalRequired')],
      ['a string approval setting', { ...VALID_CATALOG, approvalRequired: 'true' }],
      ['no product types', without('productTypes')],
      ['an empty product type list', { ...VALID_CATALOG, productTypes: [] }],
      ['a repeated product type', { ...VALID_CATALOG, productTypes: ['simple', 'simple'] }],
      ['a malformed product type', { ...VALID_CATALOG, productTypes: ['Simple!'] }],
      ['an underscore in a product type', { ...VALID_CATALOG, productTypes: ['foo_bar'] }],
      [
        'more than 20 product types',
        {
          ...VALID_CATALOG,
          productTypes: Array.from({ length: 21 }, (_, i) => `type-${String.fromCharCode(97 + i)}`),
        },
      ],
      ['a 65-character default family', { ...VALID_CATALOG, defaultFamily: 'a'.repeat(65) }],
      ['no default family', without('defaultFamily')],
      ['a malformed default family', { ...VALID_CATALOG, defaultFamily: 'Default Family' }],
      ['an unknown key', { ...VALID_CATALOG, photoLimits: {} }],
    ])('rejects %s', (_case, catalog) => {
      expect(() => loadMarketConfigs([withCatalog(catalog)], [QQ])).toThrow(
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
