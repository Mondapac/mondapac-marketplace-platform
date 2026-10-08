import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Account, type AccountState } from '../../domain/account';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import type { PasswordHasher } from '../ports/password-hasher';
import type { SessionTokens, ThrottleKeys } from '../ports/session-secrets';
import {
  MAX_PASSWORD_BYTES,
  SignInCustomer,
  type SignInCustomerInput,
} from './sign-in-customer.use-case';

// identity design 3.5, 6.3, 6.8 (HF1, HF3, HF11, HF12), 10.2; Hassan I5; slice 2. Both Market
// fixtures with the numbers of their configuration files (AU 5 in 15 minutes then a 15-minute
// block per address and origin; ZZ 4 in 10 then 20).

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Customer@Example.com';
const CLIENT = { origin: '203.0.113.7', address: '203.0.113.7' };
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigIdentityPolicy(markets);

const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};

class CountingTokens implements SessionTokens {
  issued = 0;
  issue() {
    this.issued += 1;
    const token = `ms1_${String(this.issued).padStart(43, 'T')}`;
    return { token, tokenHash: this.hashOf(token) };
  }
  hashOf(token: string): Uint8Array {
    return new Uint8Array(createHash('sha256').update(token).digest());
  }
}

/** The steps a sign-in took, in order, for the structural timing test (HF12). */
type Step = 'unit' | 'verify' | 'hash';

function setUp() {
  const fakes = new IdentityFakes();
  const steps: Step[] = [];
  const clock = new FixedClock(START);
  const unitOfWork: UnitOfWork = {
    run: <T, E>(market: MarketContext, work: () => Promise<Result<T, E>>) => {
      steps.push('unit');
      return fakes.unitOfWork.run(market, work);
    },
    runOnce: (m, delivery, work, options) => fakes.unitOfWork.runOnce(m, delivery, work, options),
  };
  const hasher: PasswordHasher = {
    hash: (plain) => {
      steps.push('hash');
      return fakes.hasher.hash(plain);
    },
    verify: (plain, stored) => {
      steps.push('verify');
      return fakes.hasher.verify(plain, stored);
    },
  };
  const tokens = new CountingTokens();
  const useCase = new SignInCustomer(createUseCaseGate(markets, null), {
    unitOfWork,
    accounts: fakes.accountRepository,
    sessions: fakes.sessionRepository,
    throttles: fakes.throttleRepository,
    records: fakes.recordRepository,
    hasher,
    tokens,
    keys,
    policy,
    clock,
    ids: new SequenceIdGenerator(clock),
  });
  return { fakes, steps, clock, tokens, hasher, useCase };
}

function accountState(code: string, overrides: Partial<AccountState> = {}): AccountState {
  return {
    id: `0199${code === 'AU' ? '0000' : '1111'}-0000-7000-8000-000000000001` as Id<'Account'>,
    marketId: code as AccountState['marketId'],
    population: 'customer',
    email: { typed: EMAIL, normalized: EMAIL.toLowerCase() },
    displayName: null,
    status: 'active',
    emailVerifiedAt: START.subtract({ hours: 1 }),
    existingAccountNoticeAt: null,
    signedUpAt: START.subtract({ hours: 2 }),
    createdAt: START.subtract({ hours: 2 }),
    version: 2,
    credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: START.subtract({ hours: 2 }) },
    ...overrides,
  };
}

describe.each(TEST_MARKETS)('SignInCustomer in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const context = testCallContext(market, 'anonymous', 'sign-in-test-0001');
  const rule = policy.signInThrottles(market).accountOrigin;
  const lifetime = policy.sessionLifetime(market, 'customer')!;
  const input = (fields: Partial<SignInCustomerInput> = {}): SignInCustomerInput => ({
    email: EMAIL,
    password: PASSWORD,
    client: CLIENT,
    ...fields,
  });
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnings.mockRestore());

  const attemptsOf = (fakes: IdentityFakes) =>
    [...fakes.throttles.values()].map((row) => [row.kind, row.attempts]).sort();

  it('declares the anonymous rule under its catalogue name', () => {
    expect(SignInCustomer.access).toEqual({
      name: 'identity.sign-in-customer',
      rule: { kind: 'anonymous' },
    });
  });

  it("opens a session with the Market's lifetimes, releases the reservation and records it", async () => {
    const { useCase, fakes } = setUp();
    fakes.seedAccount(accountState(code));

    const result = await useCase.execute(context, input({ email: '  customer@EXAMPLE.com ' }));

    expect(result).toEqual({
      ok: true,
      value: {
        code: 'signed-in',
        token: expect.stringMatching(/^ms1_/) as unknown,
        absoluteLifetimeSeconds: lifetime.absoluteLifetimeSeconds,
      },
    });
    const [stored] = [...fakes.sessions.values()];
    expect(stored!.session).toMatchObject({
      marketId: code,
      population: 'customer',
      transport: 'cookie',
      idleTimeoutSeconds: lifetime.idleTimeoutSeconds,
      absoluteExpiresAt: START.add({ seconds: lifetime.absoluteLifetimeSeconds }),
    });
    // Only the hash of the token is stored.
    expect(JSON.stringify(stored)).not.toContain(result.ok ? result.value.token : 'x');
    expect(attemptsOf(fakes)).toEqual([
      ['sign-in.account', 0],
      ['sign-in.account-origin', 0],
      ['sign-in.origin', 0],
    ]);
    expect(fakes.records).toEqual([
      expect.objectContaining({
        marketId: code,
        population: 'customer',
        accountId: accountState(code).id,
        outcome: 'signed-in',
        sessionId: stored!.session.id,
        address: CLIENT.address,
        correlationId: 'sign-in-test-0001',
      }),
    ]);
    expect(JSON.stringify(fakes.records)).not.toMatch(/customer@example\.com/i);
  });

  it('answers credentials.invalid to a wrong password, keeps the failure counted and records it', async () => {
    const { useCase, fakes } = setUp();
    fakes.seedAccount(accountState(code));

    await expect(useCase.execute(context, input({ password: `${PASSWORD}!` }))).resolves.toEqual({
      ok: false,
      error: { code: 'credentials.invalid' },
    });
    expect(attemptsOf(fakes)).toEqual([
      ['sign-in.account', 1],
      ['sign-in.account-origin', 1],
      ['sign-in.origin', 1],
    ]);
    expect(fakes.sessions.size).toBe(0);
    expect(fakes.records.map((r) => [r.outcome, r.accountId])).toEqual([
      ['credentials.invalid', accountState(code).id],
    ]);
  });

  it('answers the same to an unknown address, after verifying against the dummy hash (HF12)', async () => {
    const { useCase, fakes } = setUp();

    await expect(useCase.execute(context, input())).resolves.toEqual({
      ok: false,
      error: { code: 'credentials.invalid' },
    });
    expect(fakes.verified).toBe(1);
    expect(fakes.records.map((r) => [r.outcome, r.accountId])).toEqual([
      ['credentials.invalid', null],
    ]);
  });

  it('answers credentials.invalid for an account of another Market (AC 1)', async () => {
    const { useCase, fakes } = setUp();
    const other = TEST_MARKETS.find((m) => m !== code)!;
    fakes.seedAccount(accountState(other));

    await expect(useCase.execute(context, input())).resolves.toEqual({
      ok: false,
      error: { code: 'credentials.invalid' },
    });
  });

  it('costs the same for an unknown address, a wrong password and an unverified account (HF12)', async () => {
    const paths: Step[][] = [];
    for (const arrange of [
      () => undefined,
      (fakes: IdentityFakes) => fakes.seedAccount(accountState(code)),
      (fakes: IdentityFakes) => fakes.seedAccount(accountState(code, { emailVerifiedAt: null })),
    ]) {
      const { useCase, fakes, steps } = setUp();
      arrange(fakes);
      const password = paths.length === 1 ? `${PASSWORD}!` : PASSWORD;
      await useCase.execute(context, input({ password }));
      paths.push(steps);
    }

    // One reservation unit, one verification outside any unit, one closing unit; no hash.
    expect(paths).toEqual([
      ['unit', 'verify', 'unit'],
      ['unit', 'verify', 'unit'],
      ['unit', 'verify', 'unit'],
    ]);
  });

  it('refuses an unverified account with email-verification-required after a correct password (I5)', async () => {
    const { useCase, fakes } = setUp();
    fakes.seedAccount(accountState(code, { emailVerifiedAt: null }));

    await expect(useCase.execute(context, input())).resolves.toEqual({
      ok: false,
      error: { code: 'email-verification-required' },
    });
    expect(fakes.sessions.size).toBe(0);
    expect(fakes.records.map((r) => r.outcome)).toEqual(['email-verification-required']);
    // The password was right: the reservation is given back.
    expect(attemptsOf(fakes).every(([, attempts]) => attempts === 0)).toBe(true);
  });

  it('refuses a disabled account with account.disabled after a correct password', async () => {
    const { useCase, fakes } = setUp();
    fakes.seedAccount(accountState(code, { status: 'disabled' }));

    await expect(useCase.execute(context, input())).resolves.toEqual({
      ok: false,
      error: { code: 'account.disabled' },
    });
    expect(fakes.sessions.size).toBe(0);
  });

  it('a wrong password for an unverified or disabled account tells nothing of its state', async () => {
    for (const overrides of [{ emailVerifiedAt: null }, { status: 'disabled' as const }]) {
      const { useCase, fakes } = setUp();
      fakes.seedAccount(accountState(code, overrides));

      await expect(useCase.execute(context, input({ password: 'wrong' }))).resolves.toEqual({
        ok: false,
        error: { code: 'credentials.invalid' },
      });
    }
  });

  describe('throttling (HF1, AC 13)', () => {
    it('blocks the address and origin at the limit and refuses without hashing, with the wait', async () => {
      const { useCase, fakes, steps, clock } = setUp();
      fakes.seedAccount(accountState(code));
      for (let n = 0; n < rule.limit; n += 1) {
        await useCase.execute(context, input({ password: 'wrong' }));
      }
      steps.length = 0;
      clock.advance(Temporal.Duration.from({ seconds: 30 }));

      // Even the right password is refused while blocked.
      await expect(useCase.execute(context, input())).resolves.toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: rule.blockMinutes * 60 - 30 },
      });
      expect(steps).toEqual(['unit']);
      expect(fakes.records.at(-1)).toMatchObject({ outcome: 'request.throttled' });
      expect(fakes.sessions.size).toBe(0);
    });

    it('lets the address in again from another origin, and from this one once the block ends', async () => {
      const { useCase, fakes, clock } = setUp();
      fakes.seedAccount(accountState(code));
      for (let n = 0; n < rule.limit; n += 1) {
        await useCase.execute(context, input({ password: 'wrong' }));
      }

      const elsewhere = { origin: '198.51.100.9', address: '198.51.100.9' };
      await expect(useCase.execute(context, input({ client: elsewhere }))).resolves.toMatchObject({
        ok: true,
      });
      clock.advance(Temporal.Duration.from({ minutes: rule.blockMinutes }));
      await expect(useCase.execute(context, input())).resolves.toMatchObject({ ok: true });
    });

    it('answers the same throttle to an unknown address (uniform)', async () => {
      const { useCase } = setUp();
      for (let n = 0; n < rule.limit; n += 1) {
        await useCase.execute(context, input({ password: 'wrong' }));
      }

      await expect(useCase.execute(context, input())).resolves.toMatchObject({
        ok: false,
        error: { code: 'request.throttled' },
      });
    });

    it('fails closed with access.unavailable when the counters cannot be reached, hashing nothing', async () => {
      const { useCase, fakes, steps } = setUp();
      fakes.seedAccount(accountState(code));
      fakes.throttlesDown = true;

      await expect(useCase.execute(context, input())).resolves.toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      expect(steps).toEqual(['unit']);
      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'identity.sign-in.throttle-unavailable', marketId: code }),
      );
    });
  });

  it('fails closed with access.unavailable when the closing unit throws, opening no session', async () => {
    const { useCase, fakes } = setUp();
    fakes.seedAccount(accountState(code));
    fakes.sessionRepository.add = () => Promise.reject(new Error('session table unreachable'));

    await expect(useCase.execute(context, input())).resolves.toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    expect(warnings).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'identity.sign-in.unit-unavailable',
        unit: 'closing',
        marketId: code,
      }),
    );
  });

  it('fails closed with access.unavailable when the busy-path release unit throws', async () => {
    const { useCase, fakes } = setUp();
    fakes.seedAccount(accountState(code));
    fakes.busy = true;
    fakes.throttleRepository.release = () => Promise.reject(new Error('counter table unreachable'));

    await expect(useCase.execute(context, input())).resolves.toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    expect(warnings).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'identity.sign-in.unit-unavailable', unit: 'release' }),
    );
  });

  it('answers request.busy when the hash queue is full and gives the reservation back', async () => {
    const { useCase, fakes } = setUp();
    fakes.seedAccount(accountState(code));
    fakes.busy = true;

    await expect(useCase.execute(context, input())).resolves.toEqual({
      ok: false,
      error: { code: 'request.busy', retryAfterSeconds: 1 },
    });
    expect(attemptsOf(fakes).every(([, attempts]) => attempts === 0)).toBe(true);
    expect(fakes.records.map((r) => r.outcome)).toEqual(['request.busy']);
  });

  it('replaces a hash made with older parameters, keeping changedAt and recording no event', async () => {
    const { useCase, fakes, hasher } = setUp();
    fakes.seedAccount(accountState(code));
    const verify = hasher.verify.bind(hasher);
    hasher.verify = async (plain, stored) => {
      const result = await verify(plain, stored);
      return result.ok ? ok({ ...result.value, needsRehash: true }) : result;
    };
    hasher.hash = () => {
      fakes.hashed += 1;
      return Promise.resolve(ok('$argon2id$v=19$m=65536,t=3,p=1$new'));
    };

    await useCase.execute(context, input());

    const account = fakes.accounts.get(accountState(code).id)!;
    expect(account.credential.passwordHash).toBe('$argon2id$v=19$m=65536,t=3,p=1$new');
    expect(account.version).toBe(3);
    expect(account.credential.changedAt).toEqual(accountState(code).credential.changedAt);
    expect(fakes.hashed).toBe(1);
    expect(fakes.events).toEqual([]);
  });

  it('refuses when the credential changed between the check and the closing unit (HF11)', async () => {
    const { useCase, fakes, hasher } = setUp();
    fakes.seedAccount(accountState(code));
    const verify = hasher.verify.bind(hasher);
    hasher.verify = async (plain, stored) => {
      const result = await verify(plain, stored);
      const state = fakes.accounts.get(accountState(code).id)!;
      fakes.accounts.set(
        state.id,
        Account.restore({
          ...state,
          version: state.version + 1,
          credential: { ...state.credential, passwordHash: fakeHashOf('a new password') },
        }).state,
      );
      return result;
    };

    await expect(useCase.execute(context, input())).resolves.toEqual({
      ok: false,
      error: { code: 'credentials.invalid' },
    });
    expect(fakes.sessions.size).toBe(0);
  });

  it('refuses a malformed email or an oversized password before counting anything', async () => {
    const { useCase, fakes, steps } = setUp();

    await expect(useCase.execute(context, input({ email: 'not-an-email' }))).resolves.toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] },
    });
    await expect(
      useCase.execute(context, input({ password: 'x'.repeat(MAX_PASSWORD_BYTES + 1) })),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] },
    });
    expect(steps).toEqual([]);
    expect(fakes.throttles.size).toBe(0);
  });
});
