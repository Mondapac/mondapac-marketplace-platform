import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { noRunOnce } from '../../../../../test/support/fake-run-once';
import { InMemoryCounters } from '../../../../../test/support/sellers-submit-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { HmacRateCounterKeys } from '../../infrastructure/hmac-rate-counter-keys';
import { MarketConfigMinimumOrderPolicy } from '../../infrastructure/market-config-minimum-order-policy';
import { InMemoryStoreProfiles } from '../testing/in-memory-store-profiles';
import { StoreSettingsRead } from './store-settings-read.use-case';
import { StoreSettingsSaveDelivery } from './store-settings-save-delivery.use-case';

// The seller's delivery terms in memory (package e) on both Market fixtures. A time is a clock time
// in the seller's own zone, so nothing here depends on the Market. PostgreSQL is covered by
// test/db/sellers-delivery-terms.db-spec.ts.

const START = Temporal.Instant.from('2026-10-21T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const minimumOrderPolicy = new MarketConfigMinimumOrderPolicy(markets);
const market = (code: string): MarketContext => testMarketContext(code, 'default');

const TERMS = { day: 'next-day', from: '08:00', to: '12:00', cutoff: '14:00' };
const STORED = { day: 'next-day', fromMinute: 480, toMinute: 720, cutoffMinute: 840 } as const;

function setUp() {
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const profiles = new InMemoryStoreProfiles();
  const counters = new InMemoryCounters();
  const audits: AuditEntry[] = [];
  const audit: AuditWriter = {
    record: (_context, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  let allowed = true;
  const authorisation: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const gate = createUseCaseGate(markets, authorisation);
  const unitOfWork: UnitOfWork = { run: (_market, work) => work(), runOnce: noRunOnce };
  const deps = { unitOfWork, storeProfiles: profiles, minimumOrderPolicy };
  return {
    ids,
    profiles,
    counters,
    audits,
    deny: () => void (allowed = false),
    read: new StoreSettingsRead(gate, deps),
    save: new StoreSettingsSaveDelivery(gate, {
      ...deps,
      audit,
      counters,
      counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(7)),
      clock,
    }),
  };
}
type Setup = ReturnType<typeof setUp>;

function ownerOf(t: Setup, code: string, approved = true) {
  const sellerId = t.ids.next<'Seller'>();
  t.profiles.put(market(code), sellerId, { approved });
  return { sellerId, context: contextOf(t, code, sellerId) };
}

function contextOf(t: Setup, code: string, sellerId: Id<'Seller'>): CallContext {
  return testCallContext(
    market(code),
    testAuthenticatedActor(market(code), {
      population: 'seller',
      accountId: t.ids.next<'Account'>(),
      sessionId: t.ids.next<'Session'>(),
      sellerId,
    }),
  );
}

beforeAll(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterAll(() => jest.restoreAllMocks());

describe.each(['AU', 'ZZ'])('sellers delivery terms in %s (package e)', (code) => {
  it('reads no terms before any are set', async () => {
    const t = setUp();
    const { context } = ownerOf(t, code);

    const result = await t.read.execute(context, {});

    expect(result).toMatchObject({ ok: true, value: { version: 1, delivery: null } });
  });

  it('sets terms, raises the version, shows them in the next read and audits before and after', async () => {
    const t = setUp();
    const { sellerId, context } = ownerOf(t, code);

    const saved = await t.save.execute(context, { expectedVersion: 1, delivery: TERMS });

    expect(saved).toMatchObject({ ok: true, value: { version: 2, delivery: STORED } });
    expect(t.profiles.at(market(code), sellerId)).toMatchObject({ version: 2, delivery: STORED });
    expect(await t.read.execute(context, {})).toMatchObject({
      ok: true,
      value: { version: 2, delivery: STORED },
    });
    expect(t.audits).toEqual([
      expect.objectContaining({
        action: 'sellers.delivery-terms.changed',
        targetId: sellerId,
        before: { day: null, fromMinute: null, toMinute: null, cutoffMinute: null },
        after: { day: 'next-day', fromMinute: 480, toMinute: 720, cutoffMinute: 840 },
      }),
    ]);
  });

  it('clears with null, auditing the old terms as before', async () => {
    const t = setUp();
    const { context } = ownerOf(t, code);
    await t.save.execute(context, { expectedVersion: 1, delivery: TERMS });

    const cleared = await t.save.execute(context, { expectedVersion: 2, delivery: null });

    expect(cleared).toMatchObject({ ok: true, value: { version: 3, delivery: null } });
    expect(t.audits[1]).toMatchObject({
      before: { day: 'next-day', fromMinute: 480 },
      after: { day: null, fromMinute: null, toMinute: null, cutoffMinute: null },
    });
  });

  it('keeps the minimum order the seller already has', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const minimumOrder = { amount: 2500n, currency: code === 'AU' ? 'AUD' : 'JPY' };
    t.profiles.put(market(code), sellerId, { minimumOrder });
    const context = contextOf(t, code, sellerId);

    const saved = await t.save.execute(context, { expectedVersion: 1, delivery: TERMS });

    expect(saved).toMatchObject({ ok: true, value: { minimumOrder } });
  });

  it.each([
    ['an unknown day', { ...TERMS, day: 'daily' }, 'delivery.day'],
    ['a window that closes before it opens', { ...TERMS, from: '13:00' }, 'delivery.window'],
    ['a time that is not a half hour', { ...TERMS, to: '12:10' }, 'delivery.window'],
    [
      'a same-day cut-off after the window closes',
      { ...TERMS, day: 'same-day' },
      'delivery.cutoff',
    ],
  ])('refuses %s with %s and writes nothing', async (_, delivery, refusal) => {
    const t = setUp();
    const { sellerId, context } = ownerOf(t, code);

    const result = await t.save.execute(context, { expectedVersion: 1, delivery });

    expect(result).toEqual({ ok: false, error: { code: refusal } });
    expect(t.profiles.at(market(code), sellerId)?.version).toBe(1);
    expect(t.audits).toEqual([]);
  });

  it('answers a save that changes nothing without a write or an audit row', async () => {
    const t = setUp();
    const { context } = ownerOf(t, code);
    await t.save.execute(context, { expectedVersion: 1, delivery: TERMS });
    const saves = t.profiles.saves;

    const again = await t.save.execute(context, { expectedVersion: 2, delivery: TERMS });

    expect(again).toMatchObject({ ok: true, value: { version: 2 } });
    expect(t.profiles.saves).toBe(saves);
    expect(t.audits).toHaveLength(1);
  });

  it('refuses a stale version and a malformed one, and writes nothing', async () => {
    const t = setUp();
    const { sellerId, context } = ownerOf(t, code);

    expect(await t.save.execute(context, { expectedVersion: 7, delivery: TERMS })).toEqual({
      ok: false,
      error: { code: 'conflict.stale' },
    });
    for (const expectedVersion of [0, -1, 1.5, '1', undefined]) {
      expect(await t.save.execute(context, { expectedVersion, delivery: TERMS })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    }
    expect(t.profiles.at(market(code), sellerId)?.version).toBe(1);
    expect(t.audits).toEqual([]);
  });

  it('is for approved sellers only, and the gate decides who may', async () => {
    const t = setUp();
    const pending = ownerOf(t, code, false);
    expect(await t.save.execute(pending.context, { expectedVersion: 1, delivery: TERMS })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });

    const { context } = ownerOf(t, code);
    t.deny();
    expect(await t.save.execute(context, { expectedVersion: 1, delivery: TERMS })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
  });

  it('writes to the actor’s own seller only, never to another', async () => {
    const t = setUp();
    const mine = ownerOf(t, code);
    const other = ownerOf(t, code);

    await t.save.execute(mine.context, { expectedVersion: 1, delivery: TERMS });

    expect(t.profiles.at(market(code), other.sellerId)).toMatchObject({
      version: 1,
      delivery: null,
    });
  });
});
