import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  HmacRateCounterKeys,
  LocalSellersSecretRefusedError,
  localSellersSecret,
} from './hmac-rate-counter-keys';

const SECRET = new Uint8Array(32).fill(3);
const AU = testMarketContext('AU', 'default');
const ZZ = testMarketContext('ZZ', 'default');

describe('HmacRateCounterKeys', () => {
  const keys = new HmacRateCounterKeys(SECRET);

  it('gives 32 bytes, stable for the same kind, Market and subject', () => {
    const key = keys.keyOf(AU, 'save.account.minute', 'account-1');
    expect(key).toHaveLength(32);
    expect(keys.keyOf(AU, 'save.account.minute', 'account-1')).toEqual(key);
  });

  it('separates kinds, Markets and subjects', () => {
    const base = Buffer.from(keys.keyOf(AU, 'save.account.minute', 'account-1')).toString('hex');
    for (const other of [
      keys.keyOf(AU, 'save.account.day', 'account-1'),
      keys.keyOf(ZZ, 'save.account.minute', 'account-1'),
      keys.keyOf(AU, 'save.account.minute', 'account-2'),
    ]) {
      expect(Buffer.from(other).toString('hex')).not.toBe(base);
    }
  });

  it('uses a derived key, never the stack secret itself', () => {
    const direct = createHmac('sha256', SECRET)
      .update(JSON.stringify(['save.account.minute', 'AU', 'account-1']))
      .digest();
    expect(Buffer.from(keys.keyOf(AU, 'save.account.minute', 'account-1'))).not.toEqual(direct);
  });

  it('refuses a secret of the wrong size and an empty subject', () => {
    expect(() => new HmacRateCounterKeys(new Uint8Array(16))).toThrow(TypeError);
    expect(() => keys.keyOf(AU, 'save.account.day', '')).toThrow(TypeError);
  });
});

describe('localSellersSecret', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());

  it('starts only in an explicit development or test environment', () => {
    expect(localSellersSecret({ nodeEnv: 'test', nodeEnvExplicit: true })).toHaveLength(32);
    expect(() => localSellersSecret({ nodeEnv: 'production', nodeEnvExplicit: true })).toThrow(
      LocalSellersSecretRefusedError,
    );
    expect(() => localSellersSecret({ nodeEnv: 'test', nodeEnvExplicit: false })).toThrow(
      LocalSellersSecretRefusedError,
    );
  });
});
