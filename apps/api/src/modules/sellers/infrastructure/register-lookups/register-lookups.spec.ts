import { testMarketContext } from '@mondapac/shared-kernel/testing';
import type { NormalisedIdentifier } from '../../domain/business-identifier';
import type { RegisterLookupSettings } from '../../application/ports/register-lookup-policy';
import { FixedRegisterLookupPolicy } from '../../../../../test/support/sellers-register-fakes';
import {
  FAKE_REGISTER_ADAPTER,
  FakeRegisterLookup,
  FakeRegisterLookupRefusedError,
  assertFakeRegisterLookupAllowed,
  fakeRegisterLookupAllowed,
} from './fake';
import { MarketConfigRegisterLookups, UnknownRegisterLookupAdapterError } from './index';
import { NONE_REGISTER_ADAPTER, NoneRegisterLookup } from './none';

// The `none` and `fake` register adapters and the Market-configured choice between them (sellers
// design 4.2, 7.7; slice 4a). No network is reached by either.

const id = (text: string) => text as NormalisedIdentifier;
const request = (code: string, text: string) => ({
  market: testMarketContext(code, 'default'),
  scheme: 'any-scheme',
  identifier: id(text),
});

describe('NoneRegisterLookup', () => {
  it('does not reach a register, and the honest answer if it is asked is unavailable', async () => {
    const none = new NoneRegisterLookup();
    expect(none.code).toBe(NONE_REGISTER_ADAPTER);
    expect(none.performsLookups).toBe(false);
    expect(await none.lookup()).toEqual({ outcome: 'unavailable' });
  });
});

describe('FakeRegisterLookup', () => {
  it('answers by the last character of the value, deterministically, in any Market', async () => {
    const fake = new FakeRegisterLookup();
    expect(fake.performsLookups).toBe(true);
    for (const code of ['AU', 'ZZ']) {
      expect(await fake.lookup(request(code, '1234560'))).toEqual({ outcome: 'not-found' });
      expect(await fake.lookup(request(code, '1234561'))).toEqual({ outcome: 'cancelled' });
      expect(await fake.lookup(request(code, '1234562'))).toEqual({ outcome: 'unavailable' });
      expect(await fake.lookup(request(code, '1234567'))).toMatchObject({ outcome: 'active' });
      expect(await fake.lookup(request(code, '1234567'))).toEqual(
        await fake.lookup(request(code, '1234567')),
      );
    }
  });

  it('answers a value from its table first, and records Market and scheme only', async () => {
    const fake = new FakeRegisterLookup(new Map([['1234567', { outcome: 'cancelled' }]]));
    expect(await fake.lookup(request('AU', '1234567'))).toEqual({ outcome: 'cancelled' });
    expect(fake.calls).toEqual([{ marketId: 'AU', scheme: 'any-scheme' }]);
    expect(JSON.stringify(fake.calls)).not.toContain('1234567');
  });

  it('can be made to fail, as a broken adapter would', async () => {
    const fake = new FakeRegisterLookup();
    fake.failWith = new Error('boom');
    await expect(fake.lookup(request('AU', '1234567'))).rejects.toThrow('boom');
  });

  it('refuses production, like the local sellers secret: only an explicit development or test start', () => {
    expect(fakeRegisterLookupAllowed({ nodeEnv: 'test', nodeEnvExplicit: true })).toBe(true);
    expect(fakeRegisterLookupAllowed({ nodeEnv: 'development', nodeEnvExplicit: true })).toBe(true);
    for (const environment of [
      { nodeEnv: 'production', nodeEnvExplicit: true },
      { nodeEnv: 'test', nodeEnvExplicit: false },
      { nodeEnv: 'development', nodeEnvExplicit: false },
    ] as const) {
      expect(fakeRegisterLookupAllowed(environment)).toBe(false);
      expect(() => assertFakeRegisterLookupAllowed(environment)).toThrow(
        FakeRegisterLookupRefusedError,
      );
    }
  });
});

describe('MarketConfigRegisterLookups', () => {
  const configured: RegisterLookupSettings = {
    kind: 'configured',
    adapter: FAKE_REGISTER_ADAPTER,
    maxResultAgeDays: 30,
    perAccountLimit: 5,
    perOriginLimit: 30,
    marketDailyBudget: 1000,
    legalSuffixes: [],
  };
  const fake = new FakeRegisterLookup();
  const adapters = new Map([[FAKE_REGISTER_ADAPTER, fake]]);

  it('chooses the adapter each Market`s configuration names, and `none` for a Market without one', () => {
    const policy = new FixedRegisterLookupPolicy({ AU: configured });
    const lookups = new MarketConfigRegisterLookups(policy, adapters);
    expect(lookups.of(testMarketContext('AU', 'default'))).toBe(fake);
    const none = lookups.of(testMarketContext('ZZ', 'default'));
    expect(none.code).toBe(NONE_REGISTER_ADAPTER);
    expect(none.performsLookups).toBe(false);
  });

  it('refuses an adapter nobody implements, never falling back to another one', () => {
    const policy = new FixedRegisterLookupPolicy({ ZZ: { ...configured, adapter: 'unknown-reg' } });
    const lookups = new MarketConfigRegisterLookups(policy, adapters);
    expect(() => lookups.of(testMarketContext('ZZ', 'default'))).toThrow(
      UnknownRegisterLookupAdapterError,
    );
    // The fake is not registered in an environment that refuses it.
    const production = new MarketConfigRegisterLookups(
      new FixedRegisterLookupPolicy({ AU: configured }),
      new Map(),
    );
    expect(() => production.of(testMarketContext('AU', 'default'))).toThrow(
      UnknownRegisterLookupAdapterError,
    );
  });
});
