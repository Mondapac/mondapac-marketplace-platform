import path from 'node:path';
import { InvalidConfigError, loadAppConfig as load } from './app-config';

const DATABASE_URL = 'postgresql://user:secret@localhost:5432/db';

/** Loads config with a valid DATABASE_URL and APP_ROLE unless the test overrides them. */
function loadAppConfig(env: Record<string, string | undefined>) {
  return load({ DATABASE_URL, APP_ROLE: 'api', ...env });
}

describe('loadAppConfig', () => {
  it('applies defaults and parses the hosted markets list', () => {
    const config = loadAppConfig({ HOSTED_MARKETS: 'AU, ZZ' });

    expect(config).toEqual({
      appRole: 'api',
      nodeEnv: 'development',
      nodeEnvExplicit: false,
      port: 3000,
      logLevel: 'info',
      hostedMarkets: ['AU', 'ZZ'],
      apiDocsEnabled: false,
      certificationReviewerDocumentsEnabled: false,
      marketConfigDirs: [expect.stringMatching(/config[\\/]markets$/)],
      serviceAreaConfigDirs: [expect.stringMatching(/config[\\/]service-areas$/)],
      localeConfigDirs: [expect.stringMatching(/config[\\/]locales$/)],
      databaseUrl: DATABASE_URL,
      databasePoolMax: 10,
      mailCatcherUrl: null,
      objectStoreDir: null,
      stripeSecretKey: null,
      stripeWebhookSecrets: {},
      stripeConnectWebhookSecrets: {},
      clientAddressTrust: null,
      assistantModels: {
        apiKeys: {},
        models: { fast: {}, balanced: {} },
        prices: { fast: {}, balanced: {} },
      },
      googleSignIn: null,
      mondapacDrive: { apiKeys: {}, webhookSecrets: {} },
    });
  });

  describe('the Mondapac Drive carrier (per Market: API key, webhook secret)', () => {
    const KEY = 'drive_key_0123456789abcdefghij';
    const SECRET = 'whsec-0123456789abcdefghijABCDEFGHIJ';

    it('reads each value per hosted Market', () => {
      const config = loadAppConfig({
        HOSTED_MARKETS: 'AU,ZZ',
        MONDAPAC_DRIVE_API_KEY: `AU=${KEY},ZZ=${KEY}zz`,
        MONDAPAC_DRIVE_WEBHOOK_SECRET: `AU=${SECRET}`,
      });
      expect(config.mondapacDrive).toEqual({
        apiKeys: { AU: KEY, ZZ: `${KEY}zz` },
        webhookSecrets: { AU: SECRET },
      });
    });

    it.each([
      ['MONDAPAC_DRIVE_API_KEY', 'AU=short-key'],
      ['MONDAPAC_DRIVE_API_KEY', KEY],
      ['MONDAPAC_DRIVE_WEBHOOK_SECRET', 'AU=has a space 0123456789abcdef'],
    ])('refuses %s=%j without echoing it', (name, value) => {
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', [name]: value })).toThrow(name);
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', [name]: value });
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(value.slice(3));
      }
    });

    it('refuses a Market that is not hosted, and a webhook secret equal to the key', () => {
      expect(() =>
        loadAppConfig({ HOSTED_MARKETS: 'AU', MONDAPAC_DRIVE_API_KEY: `NZ=${KEY}` }),
      ).toThrow('NZ is not in HOSTED_MARKETS');
      expect(() =>
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          MONDAPAC_DRIVE_API_KEY: `AU=${KEY}`,
          MONDAPAC_DRIVE_WEBHOOK_SECRET: `AU=${KEY}`,
        }),
      ).toThrow('must differ from MONDAPAC_DRIVE_API_KEY');
    });
  });

  describe('the Google sign-in client', () => {
    const CLIENT = {
      GOOGLE_SIGN_IN_CLIENT_ID: 'client-123.apps.googleusercontent.com',
      GOOGLE_SIGN_IN_CLIENT_SECRET: 'secret-xyz-123',
    };

    it('reads the client id and secret together', () => {
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU', ...CLIENT }).googleSignIn).toEqual({
        clientId: CLIENT.GOOGLE_SIGN_IN_CLIENT_ID,
        clientSecret: CLIENT.GOOGLE_SIGN_IN_CLIENT_SECRET,
      });
    });

    it('refuses one without the other, and a malformed value without echoing it', () => {
      expect(() =>
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          GOOGLE_SIGN_IN_CLIENT_ID: CLIENT.GOOGLE_SIGN_IN_CLIENT_ID,
        }),
      ).toThrow(/set both or neither/);
      const secret = 'has a space 0123456789';
      expect(() =>
        loadAppConfig({ HOSTED_MARKETS: 'AU', ...CLIENT, GOOGLE_SIGN_IN_CLIENT_SECRET: secret }),
      ).toThrow(/GOOGLE_SIGN_IN_CLIENT_SECRET/);
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', ...CLIENT, GOOGLE_SIGN_IN_CLIENT_SECRET: secret });
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(secret);
      }
    });
  });

  describe('the buyer assistant model (per Market: key, tiers, prices)', () => {
    it('reads each value per hosted Market, and the price in pico dollars per token', () => {
      const config = loadAppConfig({
        HOSTED_MARKETS: 'AU,NZ',
        ASSISTANT_MODEL_API_KEY: 'AU=test-key-0123456789abcdef,NZ=test-key-nz-0123456789abc',
        ASSISTANT_MODEL_FAST: 'AU=provider-model-fast-1',
        ASSISTANT_MODEL_PRICE_FAST: 'AU=0.1/0.5,NZ=2/10.25',
      });
      expect(config.assistantModels).toEqual({
        apiKeys: { AU: 'test-key-0123456789abcdef', NZ: 'test-key-nz-0123456789abc' },
        models: { fast: { AU: 'provider-model-fast-1' }, balanced: {} },
        prices: {
          fast: {
            AU: { inputPicoUsd: 100_000, outputPicoUsd: 500_000 },
            NZ: { inputPicoUsd: 2_000_000, outputPicoUsd: 10_250_000 },
          },
          balanced: {},
        },
      });
    });

    it.each([
      ['ASSISTANT_MODEL_API_KEY', 'AU=short'],
      ['ASSISTANT_MODEL_API_KEY', 'test-key-0123456789abcdef'],
      ['ASSISTANT_MODEL_API_KEY', 'AU=has a space in it 0123456789'],
      ['ASSISTANT_MODEL_FAST', 'AU=bad model id'],
      ['ASSISTANT_MODEL_BALANCED', 'AU=-leading-dash'],
      ['ASSISTANT_MODEL_PRICE_FAST', 'AU=0.1'],
      ['ASSISTANT_MODEL_PRICE_BALANCED', 'AU=-1/2'],
    ])('refuses %s=%j without echoing it', (name, value) => {
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', [name]: value })).toThrow(name);
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', [name]: value });
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(value.slice(3));
      }
    });

    it.each([
      [
        'a Market that is not hosted',
        'NZ=test-key-0123456789abcdef',
        'NZ is not in HOSTED_MARKETS',
      ],
      [
        'a Market named twice',
        'AU=test-key-0123456789abcdef,AU=test-key-0123456789abcdeg',
        'AU is named twice',
      ],
    ])('refuses %s', (_label, value, issue) => {
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', ASSISTANT_MODEL_API_KEY: value })).toThrow(
        issue,
      );
    });
  });

  describe('the BFF client address (ADR-0037)', () => {
    const SECRET = Buffer.alloc(32, 7).toString('base64');

    it.each([
      ['unset', {}],
      ['empty', { TRUSTED_BFF_CIDRS: '', CLIENT_ADDRESS_KEYS: '' }],
      ['blank', { TRUSTED_BFF_CIDRS: ' ', CLIENT_ADDRESS_KEYS: '  ' }],
    ])('is off when both variables are %s', (_label, env) => {
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU', ...env }).clientAddressTrust).toBeNull();
    });

    it('parses the networks and the keys', () => {
      const trust = loadAppConfig({
        HOSTED_MARKETS: 'AU',
        TRUSTED_BFF_CIDRS: '10.20.0.0/16',
        CLIENT_ADDRESS_KEYS: `panel:10.20.1.0/24:${SECRET}`,
      }).clientAddressTrust;

      expect(trust?.bffCidrs.map((cidr) => cidr.text)).toEqual(['10.20.0.0/16']);
      expect([...(trust?.keys.keys() ?? [])]).toEqual(['panel']);
    });

    it('refuses to start on a bad setting and never prints the secret', () => {
      let error: unknown;
      try {
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          TRUSTED_BFF_CIDRS: '10.20.0.0/16',
          CLIENT_ADDRESS_KEYS: `panel:10.20.1.0/24:${SECRET};panel:10.20.1.0/24:${SECRET}`,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(InvalidConfigError);
      const message = (error as InvalidConfigError).message;
      expect(message).toMatch(/CLIENT_ADDRESS_KEYS key "panel": the keyId is listed twice/);
      expect(message).not.toContain(SECRET);
    });
  });

  it('takes the local mail catcher from MAIL_CATCHER_URL (identity design 9)', () => {
    expect(
      loadAppConfig({ HOSTED_MARKETS: 'AU', MAIL_CATCHER_URL: 'http://localhost:8025' })
        .mailCatcherUrl,
    ).toBe('http://localhost:8025');
  });

  it.each(['localhost:8025', 'ftp://localhost', 'not a url', ''])(
    'rejects MAIL_CATCHER_URL=%p',
    (value) => {
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', MAIL_CATCHER_URL: value })).toThrow(
        /MAIL_CATCHER_URL/,
      );
    },
  );

  it('takes a Stripe test-mode key and refuses a live one without echoing it', () => {
    const test = 'sk_test_abcdefgh12345678';
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU', STRIPE_SECRET_KEY: test }).stripeSecretKey).toBe(
      test,
    );
    const live = 'sk_live_abcdefgh12345678';
    let message = '';
    try {
      loadAppConfig({ HOSTED_MARKETS: 'AU', STRIPE_SECRET_KEY: live });
    } catch (caught) {
      message = (caught as Error).message;
    }
    expect(message).toMatch(/STRIPE_SECRET_KEY: must be a Stripe test-mode key/);
    expect(message).not.toContain(live);
  });

  it('takes a Connect signing secret and refuses one equal to the platform secret', () => {
    const connect = 'whsec_connect12345678';
    expect(
      loadAppConfig({
        HOSTED_MARKETS: 'AU',
        STRIPE_WEBHOOK_SECRET: 'whsec_abcdefgh12345678',
        STRIPE_CONNECT_WEBHOOK_SECRET: connect,
      }).stripeConnectWebhookSecrets,
    ).toEqual({ AU: connect });
    expect(() =>
      loadAppConfig({
        HOSTED_MARKETS: 'AU',
        STRIPE_WEBHOOK_SECRET: connect,
        STRIPE_CONNECT_WEBHOOK_SECRET: connect,
      }),
    ).toThrow(/AU must differ/);
  });

  it('takes a Stripe webhook signing secret and refuses anything else without echoing it', () => {
    const secret = 'whsec_abcdefgh12345678';
    expect(
      loadAppConfig({ HOSTED_MARKETS: 'AU,ZZ', STRIPE_WEBHOOK_SECRET: secret })
        .stripeWebhookSecrets,
    ).toEqual({ AU: secret, ZZ: secret });
    expect(
      loadAppConfig({
        HOSTED_MARKETS: 'AU,ZZ',
        STRIPE_WEBHOOK_SECRET: `AU=${secret},ZZ=whsec_zzzzzzzz12345678`,
      }).stripeWebhookSecrets,
    ).toEqual({ AU: secret, ZZ: 'whsec_zzzzzzzz12345678' });
    for (const [value, issue] of [
      [`AU=${secret},AU=${secret}`, /AU is named twice/],
      [`QQ=${secret}`, /QQ is not in HOSTED_MARKETS/],
    ] as const) {
      let refused = '';
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', STRIPE_WEBHOOK_SECRET: value });
      } catch (caught) {
        refused = (caught as Error).message;
      }
      expect(refused).toMatch(issue);
      expect(refused).not.toContain(secret);
    }
    const wrong = 'sk_test_abcdefgh12345678';
    let message = '';
    try {
      loadAppConfig({ HOSTED_MARKETS: 'AU', STRIPE_WEBHOOK_SECRET: wrong });
    } catch (caught) {
      message = (caught as Error).message;
    }
    expect(message).toMatch(
      /STRIPE_WEBHOOK_SECRET: must be a Stripe webhook signing secret \(whsec_\), or MARKET=whsec_ pairs/,
    );
    expect(message).not.toContain(wrong);
  });

  it('records whether NODE_ENV was set or defaulted (M2)', () => {
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU', NODE_ENV: 'development' })).toMatchObject({
      nodeEnv: 'development',
      nodeEnvExplicit: true,
    });
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU' })).toMatchObject({
      nodeEnv: 'development',
      nodeEnvExplicit: false,
    });
  });

  it.each(['api', 'worker'] as const)('takes the process role %s from APP_ROLE', (role) => {
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU', APP_ROLE: role }).appRole).toBe(role);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['unknown', 'scheduler'],
    ['in upper case', 'WORKER'],
  ])(
    'refuses an APP_ROLE that is %s: there is no default (platform persistence 8, PA7)',
    (_case, value) => {
      expect.assertions(2);
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', APP_ROLE: value });
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidConfigError);
        expect((error as InvalidConfigError).issues).toEqual([
          'APP_ROLE: APP_ROLE is required and must be "api" or "worker"; there is no default',
        ]);
      }
    },
  );

  it('takes the pool maximum from DATABASE_POOL_MAX (platform persistence design 3.1 row 8)', () => {
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU', DATABASE_POOL_MAX: '25' }).databasePoolMax).toBe(
      25,
    );
  });

  it.each(['0', '101', '2.5', 'many', ''])('rejects DATABASE_POOL_MAX=%p', (value) => {
    expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', DATABASE_POOL_MAX: value })).toThrow(
      /DATABASE_POOL_MAX/,
    );
  });

  it('serves API docs only when explicitly enabled', () => {
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU', API_DOCS_ENABLED: 'true' }).apiDocsEnabled).toBe(
      true,
    );
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU', NODE_ENV: 'development' }).apiDocsEnabled).toBe(
      false,
    );
    expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', API_DOCS_ENABLED: 'yes' })).toThrow(
      /API_DOCS_ENABLED/,
    );
  });

  it('lets a reviewer download certificate files only when explicitly enabled', () => {
    const base = { HOSTED_MARKETS: 'AU' };
    expect(loadAppConfig(base).certificationReviewerDocumentsEnabled).toBe(false);
    expect(
      loadAppConfig({ ...base, CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED: 'true' })
        .certificationReviewerDocumentsEnabled,
    ).toBe(true);
    expect(() =>
      loadAppConfig({ ...base, CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED: 'yes' }),
    ).toThrow(/CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED/);
  });

  it('takes the market configuration directory from MARKET_CONFIG_DIR', () => {
    const config = loadAppConfig({ HOSTED_MARKETS: 'ZZ', MARKET_CONFIG_DIR: '/etc/markets' });

    expect(config.marketConfigDirs).toEqual([path.resolve('/etc/markets')]);
  });

  it('takes the service-area directory from SERVICE_AREA_CONFIG_DIR', () => {
    const config = loadAppConfig({ HOSTED_MARKETS: 'ZZ', SERVICE_AREA_CONFIG_DIR: '/etc/areas' });

    expect(config.serviceAreaConfigDirs).toEqual([path.resolve('/etc/areas')]);
  });

  it('takes the translation catalogue directory from LOCALE_CONFIG_DIR', () => {
    const config = loadAppConfig({ HOSTED_MARKETS: 'ZZ', LOCALE_CONFIG_DIR: '/etc/locales' });

    expect(config.localeConfigDirs).toEqual([path.resolve('/etc/locales')]);
  });

  it('accepts a single hosted market, whichever market it is', () => {
    expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).hostedMarkets).toEqual(['AU']);
    expect(loadAppConfig({ HOSTED_MARKETS: 'ZZ' }).hostedMarkets).toEqual(['ZZ']);
  });

  it('refuses to start without HOSTED_MARKETS instead of assuming a default market', () => {
    expect(() => loadAppConfig({})).toThrow(InvalidConfigError);
    expect(() => loadAppConfig({})).toThrow(/HOSTED_MARKETS/);
  });

  it.each(['', ' , ', 'au', 'AU,AU', 'AUSTRALIA1', 'A'])('rejects HOSTED_MARKETS=%p', (value) => {
    expect(() => loadAppConfig({ HOSTED_MARKETS: value })).toThrow(InvalidConfigError);
  });

  it.each(['0', '70000', 'abc', '80.5'])('rejects PORT=%p', (port) => {
    expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', PORT: port })).toThrow(/PORT/);
  });

  it('refuses a worker that would drop info lines, the audit anchors among them', () => {
    for (const level of ['fatal', 'error', 'warn', 'silent']) {
      expect(() =>
        loadAppConfig({
          APP_ROLE: 'worker',
          HOSTED_MARKETS: 'AU',
          DATABASE_URL: 'postgresql://u:p@h/d',
          LOG_LEVEL: level,
        }),
      ).toThrow(/LOG_LEVEL: the worker logs at info/);
    }
    for (const level of ['info', 'debug', 'trace']) {
      expect(
        loadAppConfig({
          APP_ROLE: 'worker',
          HOSTED_MARKETS: 'AU',
          DATABASE_URL: 'postgresql://u:p@h/d',
          LOG_LEVEL: level,
        }).logLevel,
      ).toBe(level);
    }
    expect(
      loadAppConfig({
        APP_ROLE: 'api',
        HOSTED_MARKETS: 'AU',
        DATABASE_URL: 'postgresql://u:p@h/d',
        LOG_LEVEL: 'warn',
      }).logLevel,
    ).toBe('warn');
  });

  it('rejects an unknown NODE_ENV and LOG_LEVEL', () => {
    expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it.each([undefined, '', 'mysql://localhost/db', 'localhost:5432'])(
    'rejects DATABASE_URL=%p',
    (url) => {
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', DATABASE_URL: url })).toThrow(
        /DATABASE_URL/,
      );
    },
  );

  it('never includes the database password in a validation error', () => {
    expect.assertions(1);
    try {
      loadAppConfig({ DATABASE_URL, PORT: 'abc' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('reports every problem at once', () => {
    try {
      loadAppConfig({ PORT: 'abc' });
      throw new Error('expected loadAppConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect((error as InvalidConfigError).issues).toHaveLength(2);
    }
  });

  it.each(
    ['development', 'test', 'production'].flatMap((nodeEnv) =>
      ['postgresql://mondapac_migrator:secret@localhost:5432/mondapac', ''].map(
        (value) => [nodeEnv, value] as const,
      ),
    ),
  )(
    'refuses MIGRATION_DATABASE_URL in the environment (NODE_ENV %s, value %p) without printing its value',
    (nodeEnv, value) => {
      expect.assertions(3);
      try {
        loadAppConfig({ NODE_ENV: nodeEnv, HOSTED_MARKETS: 'AU', MIGRATION_DATABASE_URL: value });
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidConfigError);
        expect((error as InvalidConfigError).issues).toEqual([
          expect.stringMatching(/^MIGRATION_DATABASE_URL: must not be set/) as unknown,
        ]);
        expect((error as Error).message).not.toContain('secret');
      }
    },
  );
});
