import path from 'node:path';
import { InvalidConfigError, loadAppConfig as load } from './app-config';

const DATABASE_URL = 'postgresql://user:secret@localhost:5432/db';

/** The Redis a production configuration needs (ADR-0054): rediss:// and the ACL user. */
const PRODUCTION_REDIS = {
  REDIS_URL: 'rediss://cache.internal',
  REDIS_USERNAME: 'mondapac-rate-limit',
  REDIS_PASSWORD: 'a-long-secret-from-k1',
};

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
      rateLimitStore: { store: 'postgres' },
      mailCatcherUrl: null,
      objectStore: null,
      malwareScanner: null,
      stripeSecretKey: null,
      stripePaymentMethodConfiguration: null,
      stripeWebhookSecrets: {},
      stripeConnectWebhookSecrets: {},
      externalAccountHmac: { keys: {}, currentVersion: null },
      promotionsCodePepper: null,
      assistantPreviewTokenKey: null,
      securityOnCallFile: null,
      clientAddressTrust: null,
      aiKillSwitch: false,
      storefrontIndexing: { ceiling: 'off', sampleData: true },
      seedJobsOff: [],
      assistantModels: {
        apiKeys: {},
        bedrockApiKeys: {},
        inHouseApiKeys: {},
        removedVariables: [],
      },
      googleSignIn: null,
      mondapacDrive: { apiKeys: {}, webhookSecrets: {} },
      uberDirect: { customerIds: {}, clientIds: {}, clientSecrets: {}, webhookSecrets: {} },
      zoom2u: { apiKeys: {} },
      doordashDrive: { developerIds: {}, keyIds: {}, signingSecrets: {} },
      auspost: { apiKeys: {}, apiPasswords: {}, accountNumbers: {} },
    });
  });

  describe('the Redis of the rate-limit counters (ADR-0054)', () => {
    const issuesOf = (env: Record<string, string>): string => {
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', ...env });
      } catch (error) {
        if (error instanceof InvalidConfigError) return error.message;
        throw error;
      }
      return '';
    };

    it('counts in PostgreSQL locally when REDIS_URL is unset, and in Redis when it is set', () => {
      expect(
        loadAppConfig({ HOSTED_MARKETS: 'AU', NODE_ENV: 'development' }).rateLimitStore,
      ).toEqual({ store: 'postgres' });
      expect(
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          NODE_ENV: 'test',
          REDIS_URL: 'redis://127.0.0.1:6380/2',
        }).rateLimitStore,
      ).toEqual({
        store: 'redis',
        redis: { host: '127.0.0.1', port: 6380, db: 2, tls: false, username: null, password: null },
      });
    });

    it('takes the ACL user and password from their own variables, never from the URL', () => {
      expect(
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          NODE_ENV: 'production',
          CLAMD_HOST: 'clamd',
          REDIS_URL: 'rediss://cache.internal',
          REDIS_USERNAME: 'mondapac-rate-limit',
          REDIS_PASSWORD: 'a-long-secret-from-k1',
        }).rateLimitStore,
      ).toEqual({
        store: 'redis',
        redis: {
          host: 'cache.internal',
          port: 6379,
          db: 0,
          tls: true,
          username: 'mondapac-rate-limit',
          password: 'a-long-secret-from-k1',
        },
      });
      for (const url of [
        'redis://user:secret@127.0.0.1:6379',
        'redis://:secret@127.0.0.1',
        'rediss://cache.internal?rejectUnauthorized=false',
        'rediss://cache.internal/0?tls=false',
        'http://127.0.0.1:6379',
      ]) {
        const issues = issuesOf({ NODE_ENV: 'test', REDIS_URL: url });
        expect(issues).toContain('REDIS_URL: must be redis://host[:port][/db]');
        expect(issues).not.toContain('secret');
      }
    });

    it('requires rediss://, the ACL user and REDIS_URL itself in production', () => {
      const production = { NODE_ENV: 'production', CLAMD_HOST: 'clamd' };
      expect(issuesOf(production)).toContain('REDIS_URL: required when NODE_ENV is production');
      expect(
        issuesOf({
          ...production,
          REDIS_URL: 'redis://cache.internal',
          REDIS_USERNAME: 'u',
          REDIS_PASSWORD: 'p',
        }),
      ).toContain('REDIS_URL: must be rediss:// (TLS)');
      expect(issuesOf({ ...production, REDIS_URL: 'rediss://cache.internal' })).toContain(
        'REDIS_USERNAME and REDIS_PASSWORD: required',
      );
    });

    it('lets the rollback switch count everything in PostgreSQL, even with a REDIS_URL', () => {
      expect(
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          NODE_ENV: 'test',
          REDIS_URL: 'redis://127.0.0.1',
          RATE_LIMIT_STORE: 'postgres',
        }).rateLimitStore,
      ).toEqual({ store: 'postgres' });
      expect(
        issuesOf({ NODE_ENV: 'production', CLAMD_HOST: 'clamd', RATE_LIMIT_STORE: 'postgres' }),
      ).not.toContain('REDIS_URL');
    });

    it('refuses RATE_LIMIT_STORE=redis without a URL, a user without a password, and other values', () => {
      expect(issuesOf({ NODE_ENV: 'test', RATE_LIMIT_STORE: 'redis' })).toContain(
        'REDIS_URL: required when RATE_LIMIT_STORE is redis',
      );
      expect(
        issuesOf({ NODE_ENV: 'test', REDIS_URL: 'redis://127.0.0.1', REDIS_USERNAME: 'u' }),
      ).toContain('REDIS_USERNAME: set REDIS_PASSWORD with it');
      expect(issuesOf({ NODE_ENV: 'test', RATE_LIMIT_STORE: 'memory' })).toContain(
        'RATE_LIMIT_STORE',
      );
      expect(issuesOf({ NODE_ENV: 'test', REDIS_URL: 'redis://127.0.0.1/16' })).toContain(
        'REDIS_URL: the database number must be 0 to 15',
      );
    });
  });

  describe('the AI kill switch (ADR-0026 decision 8)', () => {
    it('is off when unset, on only for true, and fails boot on any other value', () => {
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).aiKillSwitch).toBe(false);
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU', AI_KILL_SWITCH: 'false' }).aiKillSwitch).toBe(
        false,
      );
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU', AI_KILL_SWITCH: 'true' }).aiKillSwitch).toBe(
        true,
      );
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', AI_KILL_SWITCH: 'yes' })).toThrow();
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', AI_KILL_SWITCH: 'TRUE' })).toThrow();
    });
  });

  describe('the catalog seed switch of the operational test environment (CATALOG_SEED_JOBS_OFF)', () => {
    const OFF = 'catalog.seed-category-tree,catalog.seed-attributes';

    it('is empty when unset and lists the switched-off jobs in development and test', () => {
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).seedJobsOff).toEqual([]);
      for (const NODE_ENV of ['development', 'test']) {
        expect(
          loadAppConfig({ HOSTED_MARKETS: 'AU', NODE_ENV, CATALOG_SEED_JOBS_OFF: OFF }).seedJobsOff,
        ).toEqual(['catalog.seed-category-tree', 'catalog.seed-attributes']);
      }
      expect(
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          NODE_ENV: 'development',
          CATALOG_SEED_JOBS_OFF: ' catalog.seed-cultures ',
        }).seedJobsOff,
      ).toEqual(['catalog.seed-cultures']);
    });

    it('fails boot in production and when NODE_ENV is not set explicitly', () => {
      expect(() =>
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          NODE_ENV: 'production',
          CLAMD_HOST: 'clamav',
          CATALOG_SEED_JOBS_OFF: OFF,
        }),
      ).toThrow(/CATALOG_SEED_JOBS_OFF: refused unless NODE_ENV/);
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', CATALOG_SEED_JOBS_OFF: OFF })).toThrow(
        /CATALOG_SEED_JOBS_OFF: refused unless NODE_ENV/,
      );
    });

    it('fails boot on a job that is not a catalog seed, and on a repeated name', () => {
      for (const value of [
        'identity.seed-roles',
        'certification.seed-types',
        'catalog.seed-category-tree,catalog.sweep-orphan-images',
        'catalog.seed-attributes,catalog.seed-attributes',
        'catalog.seed-attributes,',
      ]) {
        expect(() =>
          loadAppConfig({ HOSTED_MARKETS: 'AU', NODE_ENV: 'test', CATALOG_SEED_JOBS_OFF: value }),
        ).toThrow(/CATALOG_SEED_JOBS_OFF: must be distinct names/);
      }
    });
  });

  describe('the pepper of single-use promotion codes', () => {
    const PEPPER = 'pepper_0123456789abcdefghijABCDEFGHIJ';

    it('is null when unset and read when set', () => {
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).promotionsCodePepper).toBeNull();
      expect(
        loadAppConfig({ HOSTED_MARKETS: 'AU', PROMOTIONS_CODE_PEPPER: PEPPER })
          .promotionsCodePepper,
      ).toBe(PEPPER);
    });

    it('refuses a short pepper and never echoes it', () => {
      let message = '';
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', PROMOTIONS_CODE_PEPPER: 'short' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/PROMOTIONS_CODE_PEPPER: must be 32 to 200/);
      expect(message).not.toContain('short');
    });
  });

  describe('the key of the assistant preview token', () => {
    const KEY = 'preview_0123456789abcdefghijABCDEFGHIJ';

    it('is null when unset and read when set', () => {
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).assistantPreviewTokenKey).toBeNull();
      expect(
        loadAppConfig({ HOSTED_MARKETS: 'AU', ASSISTANT_PREVIEW_TOKEN_KEY: KEY })
          .assistantPreviewTokenKey,
      ).toBe(KEY);
    });

    it('refuses a short key and never echoes it', () => {
      let message = '';
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', ASSISTANT_PREVIEW_TOKEN_KEY: 'short-secret' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/ASSISTANT_PREVIEW_TOKEN_KEY: must be 32 to 200/);
      expect(message).not.toContain('short-secret');
    });

    it('refuses the dev-only placeholder in production only', () => {
      const placeholder = 'dev-only-assistant-preview-0123456789';
      const production = {
        HOSTED_MARKETS: 'AU',
        NODE_ENV: 'production',
        CLAMD_HOST: 'clamav',
        ...PRODUCTION_REDIS,
      };
      expect(
        loadAppConfig({ HOSTED_MARKETS: 'AU', ASSISTANT_PREVIEW_TOKEN_KEY: placeholder })
          .assistantPreviewTokenKey,
      ).toBe(placeholder);
      let message = '';
      try {
        loadAppConfig({ ...production, ASSISTANT_PREVIEW_TOKEN_KEY: placeholder });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/ASSISTANT_PREVIEW_TOKEN_KEY: a dev-only placeholder is refused/);
      expect(message).not.toContain(placeholder);
      expect(
        loadAppConfig({ ...production, ASSISTANT_PREVIEW_TOKEN_KEY: KEY }).assistantPreviewTokenKey,
      ).toBe(KEY);
    });
  });

  describe('the external account hash keys (payments, package 6c)', () => {
    const K1 = 'k1_0123456789abcdefghijABCDEFGHIJ-xyz';
    const K2 = 'k2_0123456789abcdefghijABCDEFGHIJ-xyz';

    it('has no key and no current version by default', () => {
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).externalAccountHmac).toEqual({
        keys: {},
        currentVersion: null,
      });
    });

    it('reads the keys by version and uses the highest as the current one', () => {
      const config = loadAppConfig({
        HOSTED_MARKETS: 'AU',
        PAYMENTS_EXTERNAL_ACCOUNT_HMAC_KEY_K1: K1,
        PAYMENTS_EXTERNAL_ACCOUNT_HMAC_KEY_K2: K2,
      });
      expect(config.externalAccountHmac).toEqual({ keys: { 1: K1, 2: K2 }, currentVersion: 2 });
    });

    it('lets the current version be named, as long as it has a key', () => {
      const env = {
        HOSTED_MARKETS: 'AU',
        PAYMENTS_EXTERNAL_ACCOUNT_HMAC_KEY_K1: K1,
        PAYMENTS_EXTERNAL_ACCOUNT_HMAC_KEY_K2: K2,
      };
      expect(
        loadAppConfig({ ...env, PAYMENTS_EXTERNAL_ACCOUNT_HMAC_CURRENT_VERSION: '1' })
          .externalAccountHmac.currentVersion,
      ).toBe(1);
      expect(() =>
        loadAppConfig({ ...env, PAYMENTS_EXTERNAL_ACCOUNT_HMAC_CURRENT_VERSION: '3' }),
      ).toThrow(/no key is set for version 3/);
    });

    it('refuses a short key, the same key twice, and never echoes a key', () => {
      let message = '';
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', PAYMENTS_EXTERNAL_ACCOUNT_HMAC_KEY_K1: 'short' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/PAYMENTS_EXTERNAL_ACCOUNT_HMAC_KEY_K1: must be 32 to 200/);
      expect(message).not.toContain('short');
      expect(() =>
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          PAYMENTS_EXTERNAL_ACCOUNT_HMAC_KEY_K1: K1,
          PAYMENTS_EXTERNAL_ACCOUNT_HMAC_KEY_K2: K1,
        }),
      ).toThrow(/K2: must differ from the key of another version/);
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

  describe('the Uber Direct credentials (per Market: customer id, client id, client secret)', () => {
    const SECRET = 'uber_secret_0123456789abcdefghij';

    it('reads each value per hosted Market, and none when unset', () => {
      const config = loadAppConfig({
        HOSTED_MARKETS: 'AU,ZZ',
        UBER_DIRECT_CUSTOMER_ID: 'AU=cust-0001-aaaa',
        UBER_DIRECT_CLIENT_ID: 'AU=client-0001,ZZ=client-0002',
        UBER_DIRECT_CLIENT_SECRET: `AU=${SECRET}`,
        UBER_DIRECT_WEBHOOK_SECRET: `AU=${SECRET}_hook,ZZ=${SECRET}_zz`,
      });
      expect(config.uberDirect).toEqual({
        customerIds: { AU: 'cust-0001-aaaa' },
        clientIds: { AU: 'client-0001', ZZ: 'client-0002' },
        clientSecrets: { AU: SECRET },
        webhookSecrets: { AU: `${SECRET}_hook`, ZZ: `${SECRET}_zz` },
      });
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).uberDirect.clientSecrets).toEqual({});
    });

    it('refuses a webhook secret that is short, unhosted or the client secret', () => {
      expect(() =>
        loadAppConfig({ HOSTED_MARKETS: 'AU', UBER_DIRECT_WEBHOOK_SECRET: 'AU=short' }),
      ).toThrow('UBER_DIRECT_WEBHOOK_SECRET');
      expect(() =>
        loadAppConfig({ HOSTED_MARKETS: 'AU', UBER_DIRECT_WEBHOOK_SECRET: `NZ=${SECRET}` }),
      ).toThrow('NZ is not in HOSTED_MARKETS');
      expect(() =>
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          UBER_DIRECT_CLIENT_SECRET: `AU=${SECRET}`,
          UBER_DIRECT_WEBHOOK_SECRET: `AU=${SECRET}`,
        }),
      ).toThrow('must differ from UBER_DIRECT_CLIENT_SECRET');
    });

    it('refuses a short secret and an unhosted Market without echoing the value', () => {
      expect(() =>
        loadAppConfig({ HOSTED_MARKETS: 'AU', UBER_DIRECT_CLIENT_SECRET: 'AU=too-short' }),
      ).toThrow('UBER_DIRECT_CLIENT_SECRET');
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', UBER_DIRECT_CLIENT_SECRET: `NZ=${SECRET}` });
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('NZ is not in HOSTED_MARKETS');
        expect((error as Error).message).not.toContain(SECRET);
      }
    });
  });

  describe('the DoorDash Drive credentials (per Market)', () => {
    const DEVELOPER = 'dev-0123456789-abcdef';
    const KEY_ID = 'key-0123456789-abcdef';
    const SECRET = 'c2lnbmluZy1zZWNyZXQtMDEyMzQ1Njc4OQ';

    it('reads the three values per hosted Market, and none when unset', () => {
      const config = loadAppConfig({
        HOSTED_MARKETS: 'AU,ZZ',
        DOORDASH_DEVELOPER_ID: `AU=${DEVELOPER}`,
        DOORDASH_KEY_ID: `AU=${KEY_ID}`,
        DOORDASH_SIGNING_SECRET: `AU=${SECRET}`,
      });
      expect(config.doordashDrive).toEqual({
        developerIds: { AU: DEVELOPER },
        keyIds: { AU: KEY_ID },
        signingSecrets: { AU: SECRET },
      });
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).doordashDrive.signingSecrets).toEqual({});
    });

    it('refuses a short or truncated secret and an unhosted Market without echoing the value', () => {
      expect(() =>
        loadAppConfig({ HOSTED_MARKETS: 'AU', DOORDASH_SIGNING_SECRET: 'AU=too-short' }),
      ).toThrow('DOORDASH_SIGNING_SECRET');
      // A truncated secret decodes leniently to another key: refused, without echoing it.
      const truncated = SECRET.slice(0, 33);
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', DOORDASH_SIGNING_SECRET: `AU=${truncated}` });
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('DOORDASH_SIGNING_SECRET');
        expect((error as Error).message).not.toContain(truncated);
      }
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', DOORDASH_SIGNING_SECRET: `NZ=${SECRET}` });
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('NZ is not in HOSTED_MARKETS');
        expect((error as Error).message).not.toContain(SECRET);
      }
    });
  });

  describe('the Zoom2u API key (per Market)', () => {
    const KEY = 'zoom2u.key_0123456789abcdefghij';

    it('reads the key per hosted Market, and none when unset', () => {
      const config = loadAppConfig({ HOSTED_MARKETS: 'AU,ZZ', ZOOM2U_API_KEY: `AU=${KEY}` });
      expect(config.zoom2u).toEqual({ apiKeys: { AU: KEY } });
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).zoom2u.apiKeys).toEqual({});
    });

    it('refuses a short key and an unhosted Market without echoing the value', () => {
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', ZOOM2U_API_KEY: 'AU=too-short' })).toThrow(
        'ZOOM2U_API_KEY',
      );
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', ZOOM2U_API_KEY: `NZ=${KEY}` });
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('NZ is not in HOSTED_MARKETS');
        expect((error as Error).message).not.toContain(KEY);
      }
    });
  });

  describe('the Australia Post credentials (per Market)', () => {
    const KEY = 'auspost.key_0123456789';
    const PASSWORD = 'auspost.password_0123456789';

    it('reads the three values per hosted Market, and none when unset', () => {
      const config = loadAppConfig({
        HOSTED_MARKETS: 'AU,ZZ',
        AUSPOST_API_KEY: `AU=${KEY}`,
        AUSPOST_API_PASSWORD: `AU=${PASSWORD}`,
        AUSPOST_ACCOUNT_NUMBER: 'AU=1234567890',
      });
      expect(config.auspost).toEqual({
        apiKeys: { AU: KEY },
        apiPasswords: { AU: PASSWORD },
        accountNumbers: { AU: '1234567890' },
      });
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).auspost.apiKeys).toEqual({});
    });

    it('refuses a short password and an unhosted Market without echoing the value', () => {
      expect(() =>
        loadAppConfig({ HOSTED_MARKETS: 'AU', AUSPOST_API_PASSWORD: 'AU=short' }),
      ).toThrow('AUSPOST_API_PASSWORD');
      try {
        loadAppConfig({ HOSTED_MARKETS: 'AU', AUSPOST_API_KEY: `NZ=${KEY}` });
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('NZ is not in HOSTED_MARKETS');
        expect((error as Error).message).not.toContain(KEY);
      }
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

  describe('the AI models (per Market: route keys; models from settings, prices from the catalogue)', () => {
    it('reads each value per hosted Market, and ignores the retired price variables', () => {
      const bedrockKey = 'ABSKbedrock+key/with=base64chars0123';
      const config = loadAppConfig({
        HOSTED_MARKETS: 'AU,NZ',
        ASSISTANT_MODEL_API_KEY: 'AU=test-key-0123456789abcdef,NZ=test-key-nz-0123456789abc',
        AI_BEDROCK_API_KEY: `AU=${bedrockKey}`,
        // Prices moved to the route catalogue in G3 (ADR-0052 decision 2): never read.
        ASSISTANT_MODEL_PRICE_FAST: 'AU=0.0001/0.0001',
      });
      expect(config.assistantModels).toEqual({
        apiKeys: { AU: 'test-key-0123456789abcdef', NZ: 'test-key-nz-0123456789abc' },
        bedrockApiKeys: { AU: bedrockKey },
        inHouseApiKeys: {},
        removedVariables: [],
      });
    });

    it('reads the in-house route key per hosted Market (G6a)', () => {
      const key = 'in-house-test-key-0123456789abcdef';
      expect(
        loadAppConfig({ HOSTED_MARKETS: 'AU,ZZ', AI_IN_HOUSE_API_KEY: `ZZ=${key}` }).assistantModels
          .inHouseApiKeys,
      ).toEqual({ ZZ: key });
    });

    it('boots with the removed tier variables still set, naming them (never their values) and reading nothing from them', () => {
      // G4d1: a task type's models are the Market's list in settings; the tier variables are
      // ignored, even with a value the old pattern refused, and never fail boot (R8).
      const config = loadAppConfig({
        HOSTED_MARKETS: 'AU,ZZ',
        ASSISTANT_MODEL_FAST: 'AU=provider-model-fast-1,ZZ=bad model id',
        ASSISTANT_MODEL_BALANCED: 'not even pairs',
      });
      expect(config.assistantModels).toEqual({
        apiKeys: {},
        bedrockApiKeys: {},
        inHouseApiKeys: {},
        removedVariables: ['ASSISTANT_MODEL_FAST', 'ASSISTANT_MODEL_BALANCED'],
      });
      expect(JSON.stringify(config.assistantModels)).not.toContain('provider-model-fast-1');
      expect(
        loadAppConfig({ HOSTED_MARKETS: 'AU', ASSISTANT_MODEL_FAST: '' }).assistantModels
          .removedVariables,
      ).toEqual([]);
    });

    it.each([
      ['ASSISTANT_MODEL_API_KEY', 'AU=short'],
      ['ASSISTANT_MODEL_API_KEY', 'test-key-0123456789abcdef'],
      ['ASSISTANT_MODEL_API_KEY', 'AU=has a space in it 0123456789'],
      ['AI_BEDROCK_API_KEY', 'AU=short'],
      ['AI_BEDROCK_API_KEY', 'AU=has a space in it 0123456789'],
      // G6a: the in-house route's key is at least 32 characters.
      ['AI_IN_HOUSE_API_KEY', 'AU=in-house-key-only-31-characters'],
      ['AI_IN_HOUSE_API_KEY', 'AU=has a space in it 0123456789abcdefghij'],
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

  it('takes a Stripe payment method configuration id and refuses anything else', () => {
    const id = 'pmc_1UR7zDD18uuXstC3BTXOaZWh';
    expect(
      loadAppConfig({ HOSTED_MARKETS: 'AU', STRIPE_PAYMENT_METHOD_CONFIGURATION: id })
        .stripePaymentMethodConfiguration,
    ).toBe(id);
    for (const value of ['card', 'pm_1UR7zDD18uuXstC3', 'pmc_', 'pmc_short']) {
      expect(() =>
        loadAppConfig({ HOSTED_MARKETS: 'AU', STRIPE_PAYMENT_METHOD_CONFIGURATION: value }),
      ).toThrow(/STRIPE_PAYMENT_METHOD_CONFIGURATION/);
    }
  });

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

  it('requires the virus scanner in production, so no certificate file is stored unscanned', () => {
    expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', NODE_ENV: 'production' })).toThrow(
      'CLAMD_HOST',
    );
    expect(
      loadAppConfig({
        HOSTED_MARKETS: 'AU',
        NODE_ENV: 'production',
        CLAMD_HOST: 'clamav',
        ...PRODUCTION_REDIS,
      }).malwareScanner,
    ).not.toBeNull();
    // Development and test stay free to run without one.
    expect(
      loadAppConfig({ HOSTED_MARKETS: 'AU', NODE_ENV: 'development' }).malwareScanner,
    ).toBeNull();
  });

  it('lets a reviewer download certificate files only when explicitly enabled', () => {
    const base = { HOSTED_MARKETS: 'AU' };
    expect(loadAppConfig(base).certificationReviewerDocumentsEnabled).toBe(false);
    expect(
      loadAppConfig({
        ...base,
        CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED: 'true',
        CLAMD_HOST: 'clamav',
      }).certificationReviewerDocumentsEnabled,
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
        loadAppConfig({
          NODE_ENV: nodeEnv,
          HOSTED_MARKETS: 'AU',
          CLAMD_HOST: 'clamav',
          ...PRODUCTION_REDIS,
          MIGRATION_DATABASE_URL: value,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidConfigError);
        expect((error as InvalidConfigError).issues).toEqual([
          expect.stringMatching(/^MIGRATION_DATABASE_URL: must not be set/) as unknown,
        ]);
        expect((error as Error).message).not.toContain('secret');
      }
    },
  );

  describe('object store settings', () => {
    const s3 = {
      OBJECT_STORE_DRIVER: 's3',
      OBJECT_STORE_S3_BUCKET: 'mondapac-pilot-files',
      OBJECT_STORE_S3_REGION: 'ap-southeast-2',
    };

    it('keeps the earlier behaviour: a directory alone means disk', () => {
      const config = loadAppConfig({ HOSTED_MARKETS: 'AU', OBJECT_STORE_DIR: './files' });
      expect(config.objectStore).toEqual({ driver: 'disk', dir: path.resolve('./files') });
    });

    it('accepts s3 with the default credential chain', () => {
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU', ...s3 }).objectStore).toEqual({
        driver: 's3',
        bucket: 'mondapac-pilot-files',
        region: 'ap-southeast-2',
        credentials: null,
      });
    });

    it('accepts s3 with a key pair', () => {
      const config = loadAppConfig({
        HOSTED_MARKETS: 'AU',
        ...s3,
        OBJECT_STORE_S3_ACCESS_KEY_ID: 'id',
        OBJECT_STORE_S3_SECRET_ACCESS_KEY: 'secret',
      });
      expect(config.objectStore).toMatchObject({
        credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
      });
    });

    it('lets s3 keep OBJECT_STORE_DIR for the migration command', () => {
      expect(
        loadAppConfig({ HOSTED_MARKETS: 'AU', ...s3, OBJECT_STORE_DIR: './files' }).objectStore,
      ).toMatchObject({ driver: 's3' });
    });

    it.each([
      [{ OBJECT_STORE_DRIVER: 'disk' }, 'OBJECT_STORE_DIR: required'],
      [{ OBJECT_STORE_DRIVER: 's3' }, 'OBJECT_STORE_S3_BUCKET: required'],
      [
        { OBJECT_STORE_DRIVER: 's3', OBJECT_STORE_S3_BUCKET: 'mondapac-pilot-files' },
        'OBJECT_STORE_S3_REGION: required',
      ],
      [{ ...s3, OBJECT_STORE_S3_ACCESS_KEY_ID: 'id' }, 'set both or neither'],
      [
        {
          OBJECT_STORE_DRIVER: 'disk',
          OBJECT_STORE_DIR: './f',
          OBJECT_STORE_S3_BUCKET: 'mondapac-pilot-files',
        },
        'only valid when OBJECT_STORE_DRIVER is s3',
      ],
      [{ ...s3, OBJECT_STORE_DRIVER: 'gcs' }, 'OBJECT_STORE_DRIVER'],
    ])('refuses to start with %p', (env, message) => {
      expect(() => loadAppConfig({ HOSTED_MARKETS: 'AU', ...env })).toThrow(message);
    });

    it('never puts the secret key in the error', () => {
      try {
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          ...s3,
          OBJECT_STORE_S3_SECRET_ACCESS_KEY: 'topsecretvalue',
        });
        throw new Error('should have thrown');
      } catch (error) {
        expect(String(error)).not.toContain('topsecretvalue');
      }
    });
  });

  describe('malware scanner settings', () => {
    it('has no scanner by default', () => {
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU' }).malwareScanner).toBeNull();
    });

    it('reads the clamd host with the default port and timeout', () => {
      expect(loadAppConfig({ HOSTED_MARKETS: 'AU', CLAMD_HOST: 'clamav' }).malwareScanner).toEqual({
        host: 'clamav',
        port: 3310,
        timeoutMs: 30_000,
      });
    });

    it('refuses reviewer document downloads without a scanner', () => {
      expect(() =>
        loadAppConfig({ HOSTED_MARKETS: 'AU', CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED: 'true' }),
      ).toThrow('CLAMD_HOST');
      expect(
        loadAppConfig({
          HOSTED_MARKETS: 'AU',
          CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED: 'true',
          CLAMD_HOST: 'clamav',
        }).certificationReviewerDocumentsEnabled,
      ).toBe(true);
    });

    it('refuses a bad port or timeout', () => {
      expect(() =>
        loadAppConfig({ HOSTED_MARKETS: 'AU', CLAMD_HOST: 'c', CLAMD_PORT: '0' }),
      ).toThrow();
      expect(() =>
        loadAppConfig({ HOSTED_MARKETS: 'AU', CLAMD_HOST: 'c', CLAMD_TIMEOUT_MS: '10' }),
      ).toThrow();
    });
  });
});
