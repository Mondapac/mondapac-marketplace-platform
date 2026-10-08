import { describe, expect, it } from 'vitest';
import { assertClientAddressForwarding, parsePanelConfig, parsePanelHosts } from './config.ts';

describe('parsePanelHosts', () => {
  it('parses origin=MARKET pairs', () => {
    expect(parsePanelHosts('http://seller.localhost:3001=AU, https://sell.example.nz=NZ')).toEqual([
      { origin: 'http://seller.localhost:3001', host: 'seller.localhost:3001', marketId: 'AU' },
      { origin: 'https://sell.example.nz', host: 'sell.example.nz', marketId: 'NZ' },
    ]);
  });

  it.each([
    ['', 'required'],
    ['seller.localhost=AU', 'not an origin'],
    ['http://a.test/path=AU', 'no path'],
    ['http://a.test=au', 'Market code'],
    ['http://a.test', 'origin=MARKET'],
    ['http://a.test=AU,http://a.test=NZ', 'twice'],
  ])('rejects %j', (raw, message) => {
    expect(() => parsePanelHosts(raw)).toThrow(message);
  });
});

describe('parsePanelConfig', () => {
  const env = {
    API_BASE_URL: 'http://localhost:3000',
    PANEL_HOSTS: 'http://seller.localhost:3001=AU',
    PANEL_PASSWORD_LENGTH: '15-128',
    PANEL_MARKET_NAME: 'Australia',
    PANEL_SUPPORT_EMAIL: 'support@example.com',
  };

  it('reads every setting', () => {
    const config = parsePanelConfig(env);
    expect(config.passwordMinLength).toBe(15);
    expect(config.passwordMaxLength).toBe(128);
    expect(config.marketName).toBe('Australia');
  });

  it.each(['API_BASE_URL', 'PANEL_HOSTS', 'PANEL_PASSWORD_LENGTH', 'PANEL_MARKET_NAME'])(
    'fails start-up without %s',
    (name) => {
      expect(() => parsePanelConfig({ ...env, [name]: undefined })).toThrow();
    },
  );
});

describe('assertClientAddressForwarding', () => {
  const base = {
    API_BASE_URL: 'http://localhost:3000',
    PANEL_PASSWORD_LENGTH: '15-128',
    PANEL_MARKET_NAME: 'Australia',
    PANEL_SUPPORT_EMAIL: 'support@example.com',
  };
  const configFor = (hosts: string) => parsePanelConfig({ ...base, PANEL_HOSTS: hosts });

  it('refuses a real host, whatever NODE_ENV is', () => {
    expect(() => assertClientAddressForwarding(configFor('https://sell.example.com=AU'))).toThrow(
      'client-address forwarding',
    );
  });

  it('allows *.localhost hosts only', () => {
    expect(() =>
      assertClientAddressForwarding(configFor('http://seller.localhost:3001=AU')),
    ).not.toThrow();
    expect(() =>
      assertClientAddressForwarding(
        configFor('http://seller.localhost:3001=AU,https://sell.example.com=NZ'),
      ),
    ).toThrow();
    expect(() => assertClientAddressForwarding(configFor('http://localhost:3001=AU'))).toThrow();
  });
});
