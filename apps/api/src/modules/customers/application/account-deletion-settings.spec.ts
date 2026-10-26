import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  DEFAULT_ACCOUNT_DELETION_SETTINGS,
  parseAccountDeletionSettings,
  parseChangeReason,
} from '../domain/account-deletion-settings';
import { AccountDeletionSettingsChanged } from '../domain/audit';
import {
  accountDeletionSettingsAggregateId,
  assertAccountDeletionAllowed,
  type AccountDeletionAvailability,
} from './account-deletion-settings-flow';
import type { CustomersDependencies } from './customers-dependencies';
import {
  MemoryAccountDeletionSettings,
  RecordingAudit,
  RecordingOutbox,
} from './testing/in-memory-account-deletion';
import { InMemoryAddresses, ReversibleAddressCipher } from './testing/in-memory-address-book';
import { ConfigAddressPolicy } from '../infrastructure/config-address-policy';
import { SetAccountDeletionSettings } from './use-cases/set-account-deletion-settings.use-case';
import { ViewAccountDeletionAvailability } from './use-cases/view-account-deletion-availability.use-case';
import { ViewAccountDeletionSettings } from './use-cases/view-account-deletion-settings.use-case';

// The account deletion setting in memory on both Market fixtures: defaults (off, 30 days),
// validation of every bound, an admin change with a version, a reason, an audit row and an
// outbox event, the conflict, the customer's read, and the guard package 2 will call.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-26T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const REASON = 'Legal review finished; buyers may now delete their account';
const on = (waitingPeriodDays = 30) => ({ enabled: true, waitingPeriodDays });

describe('parseAccountDeletionSettings', () => {
  it('ships off with a 30-day wait', () => {
    expect(DEFAULT_ACCOUNT_DELETION_SETTINGS).toEqual({ enabled: false, waitingPeriodDays: 30 });
    expect(parseAccountDeletionSettings({ ...DEFAULT_ACCOUNT_DELETION_SETTINGS })).toEqual(
      ok(DEFAULT_ACCOUNT_DELETION_SETTINGS),
    );
  });

  it('accepts the bounds 7 and 90', () => {
    expect(parseAccountDeletionSettings(on(7)).ok).toBe(true);
    expect(parseAccountDeletionSettings(on(90)).ok).toBe(true);
  });

  it.each([
    ['waitingPeriodDays', 6, 'range'],
    ['waitingPeriodDays', 91, 'range'],
    ['waitingPeriodDays', 30.5, 'type'],
    ['waitingPeriodDays', '30', 'type'],
    ['waitingPeriodDays', undefined, 'type'],
    ['enabled', 'true', 'type'],
    ['enabled', undefined, 'type'],
  ] as const)('refuses %s = %j (%s)', (field, value, code) => {
    const result = parseAccountDeletionSettings({ ...on(), [field]: value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContainEqual({ path: `settings.${field}`, code });
  });

  it('refuses a non-object', () => {
    for (const value of [null, [], 'x', 1]) {
      expect(parseAccountDeletionSettings(value)).toEqual({
        ok: false,
        error: [{ path: 'settings', code: 'type' }],
      });
    }
  });
});

describe('parseChangeReason', () => {
  it('trims, keeps Persian with its zero-width non-joiner, and takes 500 characters', () => {
    expect(parseChangeReason('  می‌خواهیم فعال کنیم ')).toEqual(ok('می‌خواهیم فعال کنیم'));
    expect(parseChangeReason('x'.repeat(500))).toEqual(ok('x'.repeat(500)));
  });

  it.each([
    [undefined, 'type'],
    [42, 'type'],
    ['', 'range'],
    ['   ', 'range'],
    ['x'.repeat(501), 'range'],
    ['two\nlines', 'format'],
    ['<b>why</b>', 'format'],
    ['why ‮ereht', 'format'],
    ['why\u{E0041}not', 'format'],
  ] as const)('refuses %j', (value, code) => {
    expect(parseChangeReason(value)).toEqual({ ok: false, error: { path: 'reason', code } });
  });
});

describe.each(TEST_MARKET_IDS)('account deletion setting use cases in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(
    TEST_MARKET_IDS.find((m) => m !== code)!,
    'default',
  );
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let deps: CustomersDependencies;
  let store: MemoryAccountDeletionSettings;
  let audit: RecordingAudit;
  let outbox: RecordingOutbox;
  let units: FakeUnitOfWork;

  const actor = (population: 'admin' | 'seller' | 'customer', target = market) =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? id<'Seller'>(0x51) : null,
      }),
      `deletion-${population}-abcd`,
    );

  beforeEach(() => {
    const clock = new FixedClock(T0);
    store = new MemoryAccountDeletionSettings();
    audit = new RecordingAudit();
    outbox = new RecordingOutbox();
    units = new FakeUnitOfWork();
    deps = {
      unitOfWork: units,
      addresses: new InMemoryAddresses(),
      cipher: new ReversibleAddressCipher(),
      policy: new ConfigAddressPolicy(markets),
      ids: new SequenceIdGenerator(clock),
      clock,
      accountDeletionSettings: store,
      audit,
      outbox,
    };
  });

  const view = (context = actor('admin')) =>
    new ViewAccountDeletionSettings(gate, deps).execute(context, {});
  const set = (
    next: unknown,
    expectedVersion: unknown = 0,
    context = actor('admin'),
    reason: unknown = REASON,
  ) =>
    new SetAccountDeletionSettings(gate, deps).execute(context, {
      settings: next,
      expectedVersion,
      reason,
    });
  const availability = (context = actor('customer')) =>
    new ViewAccountDeletionAvailability(gate, deps).execute(context, {});

  it('reads the defaults as version 0 in a read-only unit', async () => {
    expect(await view()).toEqual(ok({ version: 0, settings: DEFAULT_ACCOUNT_DELETION_SETTINGS }));
    expect(units.units.at(-1)?.options).toEqual({ readOnly: true });
  });

  it('saves a change as version 1 with the reason, an audit row and one event', async () => {
    const saved = await set(on(45));
    expect(saved).toEqual(ok({ version: 1, settings: on(45) }));
    expect(store.rows).toEqual([
      {
        market: code,
        version: 1,
        settings: on(45),
        changedAt: T0,
        changedBy: ADMIN,
        reason: REASON,
      },
    ]);
    expect(audit.entries).toEqual([
      AccountDeletionSettingsChanged.entry('account-deletion-settings', {
        before: { version: 0, enabled: false, waitingPeriodDays: 30 },
        after: { version: 1, enabled: true, waitingPeriodDays: 45 },
      }),
    ]);
    expect(outbox.events).toHaveLength(1);
    expect(outbox.events[0]).toMatchObject({
      type: 'customers.account-deletion-settings-changed.v1',
      aggregateType: 'account-deletion-settings',
      aggregateVersion: 1,
      occurredAt: T0,
      payload: {
        previousEnabled: false,
        enabled: true,
        previousWaitingPeriodDays: 30,
        waitingPeriodDays: 45,
      },
    });
  });

  it('keeps the reason and the actor out of the audit row and the event', async () => {
    await set(on(45));
    expect(JSON.stringify(audit.entries)).not.toContain(REASON);
    expect(JSON.stringify(outbox.events)).not.toContain(REASON);
    expect(Object.keys(outbox.events[0]!.payload).sort()).toEqual([
      'enabled',
      'previousEnabled',
      'previousWaitingPeriodDays',
      'waitingPeriodDays',
    ]);
  });

  it('uses one stable aggregate id per Market across versions, different across Markets', async () => {
    await set(on(45));
    await set({ enabled: false, waitingPeriodDays: 45 }, 1);
    const [first, second] = outbox.events;
    expect(first!.aggregateId).toBe(second!.aggregateId);
    expect(first!.aggregateId).toBe(accountDeletionSettingsAggregateId(market));
    expect(parseId(first!.aggregateId).ok).toBe(true);
    expect(accountDeletionSettingsAggregateId(other)).not.toBe(first!.aggregateId);
    await set(on(20), 0, actor('admin', other));
    expect(outbox.events[2]!.aggregateId).toBe(accountDeletionSettingsAggregateId(other));
  });

  it('writes nothing for the same values again, and numbers the next change 2', async () => {
    await set(on(45));
    const again = await set(on(45), 1);
    expect(again).toEqual(ok({ version: 1, settings: on(45) }));
    expect(store.rows).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
    expect(outbox.events).toHaveLength(1);

    const off = await set({ enabled: false, waitingPeriodDays: 45 }, 1);
    expect(off).toEqual(ok({ version: 2, settings: { enabled: false, waitingPeriodDays: 45 } }));
    expect(outbox.events[1]).toMatchObject({
      aggregateVersion: 2,
      payload: { previousEnabled: true, enabled: false },
    });
  });

  it('answers a conflict for a stale version or a lost race, and writes nothing', async () => {
    await set(on());
    expect(await set(on(60), 0)).toEqual({ ok: false, error: { code: 'customers.conflict' } });
    store.taken = true;
    expect(await set(on(60), 1)).toEqual({ ok: false, error: { code: 'customers.conflict' } });
    expect(store.rows).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
    expect(outbox.events).toHaveLength(1);
  });

  it('refuses a missing or empty reason, bad values and a bad version together, writing nothing', async () => {
    expect(await set(on(), 0, actor('admin'), null)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'reason', code: 'type' }] },
    });
    expect(await set(on(), 0, actor('admin'), '  ')).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'reason', code: 'range' }] },
    });
    expect(await set(on(5), -1, actor('admin'), 'x'.repeat(501))).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'expectedVersion', code: 'range' },
          { path: 'settings.waitingPeriodDays', code: 'range' },
          { path: 'reason', code: 'range' },
        ],
      },
    });
    expect(store.rows).toEqual([]);
    expect(outbox.events).toEqual([]);
  });

  it('lets no one but an admin read or change the setting', async () => {
    for (const population of ['seller', 'customer'] as const) {
      expect(await view(actor(population))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await set(on(), 0, actor(population))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    expect(await set(on(), 0, testCallContext(market, 'anonymous'))).toMatchObject({
      ok: false,
    });
    expect(store.rows).toEqual([]);
  });

  it('keeps each Market apart', async () => {
    await set(on(10));
    expect(await view(actor('admin', other))).toEqual(
      ok({ version: 0, settings: DEFAULT_ACCOUNT_DELETION_SETTINGS }),
    );
    expect(await set(on(20), 0, actor('admin', other))).toEqual(
      ok({ version: 1, settings: on(20) }),
    );
    expect(await view()).toEqual(ok({ version: 1, settings: on(10) }));
  });

  describe("the customer's read", () => {
    const OFF: AccountDeletionAvailability = { canDeleteAccount: false, waitingPeriodDays: 30 };

    it('says no by default, then yes with the wait once an admin switched it on', async () => {
      expect(await availability()).toEqual(ok(OFF));
      expect(units.units.at(-1)?.options).toEqual({ readOnly: true });
      await set(on(14));
      expect(await availability()).toEqual(ok({ canDeleteAccount: true, waitingPeriodDays: 14 }));
      await set({ enabled: false, waitingPeriodDays: 14 }, 1);
      expect(await availability()).toEqual(ok({ canDeleteAccount: false, waitingPeriodDays: 14 }));
    });

    it('answers only the two fields, and refuses a visitor', async () => {
      const read = await availability();
      expect(read.ok && Object.keys(read.value).sort()).toEqual([
        'canDeleteAccount',
        'waitingPeriodDays',
      ]);
      expect((await availability(testCallContext(market, 'anonymous'))).ok).toBe(false);
    });
  });

  describe('assertAccountDeletionAllowed', () => {
    it('fails with customers.account-deletion-disabled while off, in this Market only', async () => {
      expect(await assertAccountDeletionAllowed(store, market)).toEqual({
        ok: false,
        error: { code: 'customers.account-deletion-disabled' },
      });
      await set(on(21));
      expect(await assertAccountDeletionAllowed(store, market)).toEqual(
        ok({ waitingPeriodDays: 21 }),
      );
      expect(await assertAccountDeletionAllowed(store, other)).toEqual({
        ok: false,
        error: { code: 'customers.account-deletion-disabled' },
      });
    });

    it('fails closed: a read error propagates and never counts as allowed', async () => {
      const broken = {
        latest: () => Promise.reject(new Error('database down')),
        append: () => Promise.resolve(false),
      };
      await expect(assertAccountDeletionAllowed(broken, market)).rejects.toThrow('database down');
    });

    it('fails again once switched off', async () => {
      await set(on());
      await set({ enabled: false, waitingPeriodDays: 30 }, 1);
      expect(await assertAccountDeletionAllowed(store, market)).toEqual({
        ok: false,
        error: { code: 'customers.account-deletion-disabled' },
      });
    });
  });
});
