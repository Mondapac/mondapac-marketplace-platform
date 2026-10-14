import { testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  HmacRateCounterKeys,
  LocalInventorySecretRefusedError,
  localInventorySecret,
} from './hmac-rate-counter-keys';

const secret = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

describe('inventory HmacRateCounterKeys', () => {
  const au = testMarketContext('AU', 'default');
  const zz = testMarketContext('ZZ', 'default');
  const keys = new HmacRateCounterKeys(secret(1));

  it('gives 32 bytes, stable for the same input', () => {
    const first = keys.keyOf(au, 'reserve.account.15min', 'account-1');
    expect(first).toHaveLength(32);
    expect(keys.keyOf(au, 'reserve.account.15min', 'account-1')).toEqual(first);
  });

  it('separates kinds, Markets, subjects and secrets', () => {
    const base = keys.keyOf(au, 'reserve.account.15min', 'a');
    expect(keys.keyOf(au, 'reserve.account.day', 'a')).not.toEqual(base);
    expect(keys.keyOf(zz, 'reserve.account.15min', 'a')).not.toEqual(base);
    expect(keys.keyOf(au, 'reserve.account.15min', 'b')).not.toEqual(base);
    expect(new HmacRateCounterKeys(secret(2)).keyOf(au, 'reserve.account.15min', 'a')).not.toEqual(
      base,
    );
  });

  it('refuses an empty subject and a secret of the wrong size', () => {
    expect(() => keys.keyOf(au, 'reserve.account.15min', '')).toThrow(TypeError);
    expect(() => new HmacRateCounterKeys(new Uint8Array(16))).toThrow(TypeError);
  });

  it('starts the local stand-in only in an explicit development or test environment', () => {
    expect(localInventorySecret({ nodeEnv: 'test', nodeEnvExplicit: true })).toHaveLength(32);
    expect(() => localInventorySecret({ nodeEnv: 'test', nodeEnvExplicit: false })).toThrow(
      LocalInventorySecretRefusedError,
    );
    expect(() => localInventorySecret({ nodeEnv: 'production', nodeEnvExplicit: true })).toThrow(
      LocalInventorySecretRefusedError,
    );
  });
});
