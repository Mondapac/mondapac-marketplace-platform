import { testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  HmacRateCounterKeys,
  LocalCatalogSecretRefusedError,
  localCatalogSecret,
} from './hmac-rate-counter-keys';

const secret = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

describe('catalog HmacRateCounterKeys', () => {
  const au = testMarketContext('AU', 'default');
  const zz = testMarketContext('ZZ', 'default');
  const keys = new HmacRateCounterKeys(secret(1));

  it('gives 32 bytes, stable for the same input', () => {
    const first = keys.keyOf(au, 'draft-save.account.minute', 'account-1');
    expect(first).toHaveLength(32);
    expect(keys.keyOf(au, 'draft-save.account.minute', 'account-1')).toEqual(first);
  });

  it('separates kinds, Markets, subjects and secrets', () => {
    const base = keys.keyOf(au, 'draft-save.account.minute', 'a');
    expect(keys.keyOf(au, 'draft-save.account.day', 'a')).not.toEqual(base);
    expect(keys.keyOf(zz, 'draft-save.account.minute', 'a')).not.toEqual(base);
    expect(keys.keyOf(au, 'draft-save.account.minute', 'b')).not.toEqual(base);
    expect(
      new HmacRateCounterKeys(secret(2)).keyOf(au, 'draft-save.account.minute', 'a'),
    ).not.toEqual(base);
  });

  it('refuses an empty subject and a secret of the wrong size', () => {
    expect(() => keys.keyOf(au, 'draft-save.account.minute', '')).toThrow(TypeError);
    expect(() => new HmacRateCounterKeys(new Uint8Array(16))).toThrow(TypeError);
  });

  it('starts the local stand-in only in an explicit development or test environment', () => {
    expect(localCatalogSecret({ nodeEnv: 'test', nodeEnvExplicit: true })).toHaveLength(32);
    expect(() => localCatalogSecret({ nodeEnv: 'test', nodeEnvExplicit: false })).toThrow(
      LocalCatalogSecretRefusedError,
    );
    expect(() => localCatalogSecret({ nodeEnv: 'production', nodeEnvExplicit: true })).toThrow(
      LocalCatalogSecretRefusedError,
    );
  });
});
