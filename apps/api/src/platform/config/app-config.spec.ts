import path from 'node:path';
import { InvalidConfigError, loadAppConfig as load } from './app-config';

const DATABASE_URL = 'postgresql://user:secret@localhost:5432/db';

/** Loads config with a valid DATABASE_URL unless the test overrides it. */
function loadAppConfig(env: Record<string, string | undefined>) {
  return load({ DATABASE_URL, ...env });
}

describe('loadAppConfig', () => {
  it('applies defaults and parses the hosted markets list', () => {
    const config = loadAppConfig({ HOSTED_MARKETS: 'AU, ZZ' });

    expect(config).toEqual({
      nodeEnv: 'development',
      port: 3000,
      logLevel: 'info',
      hostedMarkets: ['AU', 'ZZ'],
      apiDocsEnabled: false,
      marketConfigDirs: [expect.stringMatching(/config[\\/]markets$/)],
      databaseUrl: DATABASE_URL,
    });
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

  it('takes the market configuration directory from MARKET_CONFIG_DIR', () => {
    const config = loadAppConfig({ HOSTED_MARKETS: 'ZZ', MARKET_CONFIG_DIR: '/etc/markets' });

    expect(config.marketConfigDirs).toEqual([path.resolve('/etc/markets')]);
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
});
