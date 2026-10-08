import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type {
  CallContext,
  MarketContext,
  PendingEvent,
  Population,
  Result,
} from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_IDS, TEST_MARKETS } from '../../../../../test/support/test-config';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { MarketConfig } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { Account, type AccountState } from '../../domain/account';
import type { PasswordRules } from '../../domain/password-policy';
import type { AccountAddRefused, AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import { RegisterCustomer } from './register-customer.use-case';

// identity design 3.2, 6.5, 6.7 (HF12), 8.6 row 1; slice 1d. Both Market fixtures, with the
// password rules of their configuration files (AU 15..128, ZZ 16..100; notice 24 h and 12 h).

const RULES: Record<string, PasswordRules> = {
  AU: { minLength: 15, maxLength: 128 },
  ZZ: { minLength: 16, maxLength: 100 },
};
const NOTICE_HOURS: Record<string, number> = { AU: 24, ZZ: 12 };
const START = Temporal.Instant.from('2026-10-07T10:00:00Z');
const GOOD_PASSWORD = 'correct horse battery staple';
const COMMON = 'iloveyouiloveyou';

/** Everything the fakes did, in order, so a test can check that the hash came first. */
type Step = 'hash' | 'unit' | 'find' | 'add' | 'save' | 'append';

class Recorder {
  readonly steps: Step[] = [];
}

/** Stores state only when a unit commits: `err` and exceptions leave nothing (P 3.1 row 3). */
class FakeStore {
  committed = new Map<string, AccountState>();
  staged: Map<string, AccountState> | null = null;
  committedEvents: PendingEvent[] = [];
  stagedEvents: PendingEvent[] = [];

  static key(market: MarketContext, population: Population, email: string): string {
    return `${market.marketId}|${population}|${email}`;
  }

  current(): Map<string, AccountState> {
    if (this.staged === null) throw new Error('outside a unit');
    return this.staged;
  }
}

class FakeUnitOfWork implements UnitOfWork {
  readonly options: (UnitOfWorkOptions | undefined)[] = [];
  constructor(
    private readonly store: FakeStore,
    private readonly recorder: Recorder,
  ) {}

  async run<T, E>(
    _market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options?: UnitOfWorkOptions,
  ): Promise<Result<T, E>> {
    this.recorder.steps.push('unit');
    this.options.push(options);
    this.store.staged = new Map(this.store.committed);
    this.store.stagedEvents = [];
    try {
      const result = await work();
      if (result.ok) {
        this.store.committed = this.store.staged;
        this.store.committedEvents.push(...this.store.stagedEvents);
      }
      return result;
    } finally {
      this.store.staged = null;
    }
  }
}

class FakeAccounts implements AccountRepository {
  refuseNextAdd: AccountAddRefused | null = null;
  constructor(
    private readonly store: FakeStore,
    private readonly recorder: Recorder,
  ) {}

  findByEmail(market: MarketContext, population: Population, email: string) {
    this.recorder.steps.push('find');
    const state = this.store.current().get(FakeStore.key(market, population, email));
    return Promise.resolve(state === undefined ? null : Account.restore(state));
  }

  add(market: MarketContext, account: Account): Promise<Result<void, AccountAddRefused>> {
    this.recorder.steps.push('add');
    if (this.refuseNextAdd !== null) {
      const refused = this.refuseNextAdd;
      this.refuseNextAdd = null;
      return Promise.resolve(err(refused));
    }
    const { state } = account;
    this.store
      .current()
      .set(FakeStore.key(market, state.population, state.email.normalized), state);
    return Promise.resolve(ok(undefined));
  }

  save(market: MarketContext, account: Account): Promise<void> {
    this.recorder.steps.push('save');
    const { state } = account;
    if (state.version !== account.persistedVersion) {
      this.store
        .current()
        .set(FakeStore.key(market, state.population, state.email.normalized), state);
    }
    return Promise.resolve();
  }
}

class FakeOutbox implements OutboxWriter {
  readonly contexts: CallContext[] = [];
  constructor(
    private readonly store: FakeStore,
    private readonly recorder: Recorder,
  ) {}

  append(context: CallContext, events: readonly PendingEvent[]): Promise<void> {
    this.recorder.steps.push('append');
    this.contexts.push(context);
    this.store.stagedEvents.push(...events);
    return Promise.resolve();
  }
}

class FakeHasher implements PasswordHasher {
  busy = false;
  count = 0;
  readonly hashed: string[] = [];
  constructor(private readonly recorder: Recorder) {}

  hash(plain: string): Promise<Result<string, PasswordHasherBusy>> {
    this.recorder.steps.push('hash');
    if (this.busy) return Promise.resolve(err({ code: 'request.busy', retryAfterSeconds: 1 }));
    this.count += 1;
    this.hashed.push(plain);
    return Promise.resolve(ok(`$argon2id$v=19$fake-${this.count}`));
  }

  verify(): never {
    throw new Error('sign-up never verifies');
  }
}

const policy: IdentityMarketPolicy = {
  passwordRules: (market) => RULES[market.marketId]!,
  existingAccountNoticeHours: (market) => NOTICE_HOURS[market.marketId]!,
};

function setUp() {
  const recorder = new Recorder();
  const store = new FakeStore();
  const clock = new FixedClock(START);
  const unitOfWork = new FakeUnitOfWork(store, recorder);
  const accounts = new FakeAccounts(store, recorder);
  const outbox = new FakeOutbox(store, recorder);
  const hasher = new FakeHasher(recorder);
  const gate = createUseCaseGate(
    new MarketRegistry(new Map(TEST_MARKET_IDS.map((id) => [id, {} as MarketConfig]))),
    null,
  );
  const useCase = new RegisterCustomer(gate, {
    unitOfWork,
    accounts,
    outbox,
    hasher,
    commonPasswords: { isCommon: (comparable) => comparable === COMMON },
    policy,
    clock,
    ids: new SequenceIdGenerator(clock),
  });
  return { recorder, store, clock, unitOfWork, accounts, outbox, hasher, useCase };
}

const accepted = { ok: true, value: { code: 'sign-up.accepted' } };
const stored = (store: FakeStore) => [...store.committed.values()];

describe.each(TEST_MARKETS)('RegisterCustomer in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const context = testCallContext(market, 'anonymous');
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnings.mockRestore());

  it('declares the anonymous rule under its catalogue name', () => {
    expect(RegisterCustomer.access).toEqual({
      name: 'identity.register-customer',
      rule: { kind: 'anonymous' },
    });
  });

  describe('a new address', () => {
    it('creates an active, unverified customer account with no display name', async () => {
      const { useCase, store, hasher } = setUp();

      await expect(
        useCase.execute(context, { email: '  New.Customer@Example.COM ', password: GOOD_PASSWORD }),
      ).resolves.toEqual(accepted);

      const [account, ...others] = stored(store);
      expect(others).toEqual([]);
      expect(account).toMatchObject({
        marketId: code,
        population: 'customer',
        email: { typed: 'New.Customer@Example.COM', normalized: 'new.customer@example.com' },
        displayName: null,
        status: 'active',
        emailVerifiedAt: null,
        signedUpAt: START,
        version: 1,
        credential: { passwordHash: '$argon2id$v=19$fake-1', changedAt: START },
      });
      expect(hasher.hashed).toEqual([GOOD_PASSWORD]);
    });

    it('appends customer-account-registered with the caller context, in the same unit', async () => {
      const { useCase, store, outbox } = setUp();

      await useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD });

      const [account] = stored(store);
      expect(store.committedEvents).toHaveLength(1);
      expect(store.committedEvents[0]).toMatchObject({
        type: 'identity.customer-account-registered.v1',
        aggregateId: account!.id,
        payload: { accountId: account!.id },
      });
      expect(outbox.contexts).toEqual([context]);
    });

    it('hashes before any read and runs one serializable unit (HF12)', async () => {
      const { useCase, recorder, unitOfWork } = setUp();

      await useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD });

      expect(recorder.steps).toEqual(['hash', 'unit', 'find', 'add', 'append']);
      expect(unitOfWork.options).toEqual([{ isolation: 'serializable' }]);
    });

    it('keeps the Markets apart: the same address in another Market is a new account', async () => {
      const { useCase, store } = setUp();
      const other = TEST_MARKETS.find((m) => m !== code)!;
      const otherContext = testCallContext(
        testMarketContext(other, PLATFORM_TENANT_ID),
        'anonymous',
      );

      await useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD });
      await useCase.execute(otherContext, { email: 'a@example.com', password: GOOD_PASSWORD });

      expect(stored(store).map((s) => [s.marketId, s.version])).toEqual([
        [code, 1],
        [other, 1],
      ]);
      expect(store.committedEvents.map((e) => e.type)).toEqual([
        'identity.customer-account-registered.v1',
        'identity.customer-account-registered.v1',
      ]);
    });
  });

  describe('an address that already has a customer account (AC 21: the same answer)', () => {
    it('unverified: replaces the password, restarts the anchor, one hash and one unit', async () => {
      const { useCase, store, clock, recorder } = setUp();
      await useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD });
      clock.advance(Temporal.Duration.from({ hours: 1 }));
      recorder.steps.length = 0;

      await expect(
        useCase.execute(context, { email: 'A@example.com', password: `${GOOD_PASSWORD}!` }),
      ).resolves.toEqual(accepted);

      const [account] = stored(store);
      expect(account).toMatchObject({
        version: 2,
        signedUpAt: clock.now(),
        credential: { passwordHash: '$argon2id$v=19$fake-2', changedAt: clock.now() },
      });
      expect(store.committedEvents.at(-1)).toMatchObject({
        type: 'identity.sign-up-repeated.v1',
        payload: { accountId: account!.id, cause: 'unverified-replaced' },
      });
      expect(recorder.steps).toEqual(['hash', 'unit', 'find', 'save', 'append']);
    });

    describe('verified', () => {
      function verify(store: FakeStore) {
        const [[key, state]] = [...store.committed.entries()] as [[string, AccountState]];
        store.committed.set(key, { ...state, emailVerifiedAt: START });
      }

      it('changes nothing but the notice instant and records verified-notice', async () => {
        const { useCase, store, hasher } = setUp();
        await useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD });
        verify(store);

        await expect(
          useCase.execute(context, { email: 'a@example.com', password: 'another long passphrase' }),
        ).resolves.toEqual(accepted);

        const [account] = stored(store);
        expect(account).toMatchObject({
          version: 2,
          existingAccountNoticeAt: START,
          credential: { passwordHash: '$argon2id$v=19$fake-1' },
        });
        expect(store.committedEvents.at(-1)).toMatchObject({
          type: 'identity.sign-up-repeated.v1',
          payload: { cause: 'verified-notice' },
        });
        // The new password was hashed all the same (HF12), then thrown away.
        expect(hasher.count).toBe(2);
      });

      it("records at most one notice per the Market's interval", async () => {
        const { useCase, store, clock, recorder } = setUp();
        await useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD });
        verify(store);
        await useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD });
        const events = store.committedEvents.length;

        clock.advance(Temporal.Duration.from({ hours: NOTICE_HOURS[code]! - 1 }));
        recorder.steps.length = 0;
        await expect(
          useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD }),
        ).resolves.toEqual(accepted);
        expect(store.committedEvents).toHaveLength(events);
        expect(stored(store)[0]!.version).toBe(2);
        // Within the interval: still one hash and one unit; nothing is written.
        expect(recorder.steps).toEqual(['hash', 'unit', 'find', 'save']);

        clock.advance(Temporal.Duration.from({ hours: 1 }));
        await useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD });
        expect(store.committedEvents).toHaveLength(events + 1);
        expect(stored(store)[0]).toMatchObject({
          version: 3,
          existingAccountNoticeAt: clock.now(),
        });
      });
    });

    it('answers the same when a concurrent sign-up took the address first', async () => {
      const { useCase, store, accounts } = setUp();
      accounts.refuseNextAdd = { code: 'account.email-taken' };

      await expect(
        useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD }),
      ).resolves.toEqual(accepted);
      expect(stored(store)).toEqual([]);
      expect(store.committedEvents).toEqual([]);
    });
  });

  describe('refusals', () => {
    it('refuses a malformed email before hashing', async () => {
      const { useCase, recorder } = setUp();

      await expect(
        useCase.execute(context, { email: 'not-an-email', password: GOOD_PASSWORD }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] },
      });
      expect(recorder.steps).toEqual([]);
    });

    it('refuses a password equal to the email: contains-identity, with no display name', async () => {
      const { useCase, recorder } = setUp();
      const email = 'longer.address@example.com';

      await expect(useCase.execute(context, { email, password: email })).resolves.toEqual({
        ok: false,
        error: { code: 'password.rejected', rule: 'contains-identity' },
      });
      expect(recorder.steps).toEqual([]);
    });

    it("applies the Market's length rule", async () => {
      const { useCase } = setUp();
      const fifteen = 'abcdefghijklmno';

      const result = await useCase.execute(context, { email: 'a@example.com', password: fifteen });

      expect(result).toEqual(
        RULES[code]!.minLength <= 15
          ? accepted
          : { ok: false, error: { code: 'password.rejected', rule: 'length' } },
      );
    });

    it('refuses a common password', async () => {
      const { useCase } = setUp();

      await expect(
        useCase.execute(context, { email: 'a@example.com', password: COMMON.toUpperCase() }),
      ).resolves.toEqual({ ok: false, error: { code: 'password.rejected', rule: 'common' } });
    });

    it('answers request.busy when the hash queue is full, and opens no unit', async () => {
      const { useCase, hasher, recorder } = setUp();
      hasher.busy = true;

      await expect(
        useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD }),
      ).resolves.toEqual({ ok: false, error: { code: 'request.busy', retryAfterSeconds: 1 } });
      expect(recorder.steps).toEqual(['hash']);
    });

    it('turns a refused CHECK into validation.failed and stores nothing', async () => {
      const { useCase, store, accounts } = setUp();
      accounts.refuseNextAdd = { code: 'validation.failed' };

      await expect(
        useCase.execute(context, { email: 'a@example.com', password: GOOD_PASSWORD }),
      ).resolves.toEqual({ ok: false, error: { code: 'validation.failed', fields: [] } });
      expect(stored(store)).toEqual([]);
      expect(store.committedEvents).toEqual([]);
    });
  });
});
