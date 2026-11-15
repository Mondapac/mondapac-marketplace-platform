import { err, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  MemoryShipToRetention,
  OrderingAuditWriter,
} from '../../../../test/support/ordering-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { FakeStepUp } from '../../../../test/support/reviews-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  ORDERING_SHIP_TO_RETENTION_MANAGE,
  ORDERING_SHIP_TO_RETENTION_VIEW,
} from '../contracts/permissions';
import { RegistryMarketZones } from '../infrastructure/prisma-ship-to-retention.repository';
import {
  SHIP_TO_PURGE_MAX_BATCHES,
  type ShipToRetentionDependencies,
} from './ship-to-retention-flow';
import { AdminSetShipToRetention } from './use-cases/admin-set-ship-to-retention.use-case';
import { AdminViewShipToRetention } from './use-cases/admin-view-ship-to-retention.use-case';
import { PurgeDeliveredShipTo } from './use-cases/purge-delivered-ship-to.use-case';

// The ship-to retention setting and its daily purge (owner decision 2026-11-15) in memory, on
// both Market fixtures (AU: Australia/Brisbane; ZZ: Asia/Tokyo). The Prisma query and the column
// grant have their database spec.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const SHIP_TO = 'v1.c2VhbGVkLXNoaXAtdG8tb2YtdGhlLWN1c3RvbWVyLWZpeHR1cmU';

describe.each([['AU'], ['ZZ']] as const)('ship-to retention in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const zone = markets.get(market.marketId).timezone;
  const local = (text: string) =>
    Temporal.PlainDateTime.from(text).toZonedDateTime(zone).toInstant();
  const NOW = local('2026-11-15T03:00:00');

  let allowed: boolean;
  let stepUp: FakeStepUp;
  let store: MemoryShipToRetention;
  let audit: OrderingAuditWriter;
  let deps: ShipToRetentionDependencies;
  let gate: ReturnType<typeof createUseCaseGate>;

  const adminCtx = (population: 'admin' | 'customer' = 'admin') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ADMIN,
        sessionId: id<'Session'>(0x62),
        sellerId: null,
      }),
      'ship-to-admin-abcd',
    );
  const system = testCallContext(market, 'system', 'ship-to-system-abcd');
  const set = (input: object, context: CallContext = adminCtx()) =>
    new AdminSetShipToRetention(gate, deps).execute(context, {
      enabled: true,
      months: 24,
      expectedVersion: 0,
      ...input,
    });
  const purge = () => new PurgeDeliveredShipTo(gate, deps).execute(system, {});
  let next = 1;
  const order = (deliveries: (string | null)[], confirmed = '2022-01-01T00:00:00') => {
    const row = {
      id: id<'Order'>(0x1000 + next++),
      marketId: market.marketId,
      status: 'confirmed' as const,
      confirmedAt: local(confirmed),
      shipTo: SHIP_TO as string | null,
      sellerOrders: deliveries.map((at) => ({ deliveredAt: at === null ? null : local(at) })),
    };
    store.orders.push(row);
    return row;
  };

  beforeEach(() => {
    allowed = true;
    const clock = new FixedClock(NOW);
    gate = createUseCaseGate(markets, {
      check: (): Promise<AccessDecision> =>
        Promise.resolve(
          allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
        ),
    });
    stepUp = new FakeStepUp();
    store = new MemoryShipToRetention();
    audit = new OrderingAuditWriter();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      retention: store,
      zones: new RegistryMarketZones(markets),
      audit,
      stepUp,
      clock,
      ids: new SequenceIdGenerator(clock),
    };
  });

  describe('the setting', () => {
    it('reads off, 24 months, version 0 while never set', async () => {
      const read = await new AdminViewShipToRetention(gate, deps).execute(adminCtx(), {});
      expect(read).toEqual({
        ok: true,
        value: { enabled: false, months: 24, version: 0, updatedAt: null, updatedBy: null },
      });
    });

    it('sets it with a fresh two-step code, audited before and after', async () => {
      const saved = await set({ enabled: true, months: 36 });
      expect(saved).toEqual({
        ok: true,
        value: {
          enabled: true,
          months: 36,
          version: 1,
          updatedAt: NOW.toString(),
          updatedBy: ADMIN,
        },
      });
      expect(stepUp.spent).toEqual(['ordering.ship-to-retention.change']);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        action: 'ordering.ship-to-retention.changed',
        targetType: 'ordering.ship-to-retention',
        before: { enabled: null, months: null },
        after: { enabled: true, months: 36, version: 1 },
      });
      const again = await set({ enabled: false, months: 12, expectedVersion: 1 });
      expect(again.ok && again.value.version).toBe(2);
      expect(audit.rows[1]).toMatchObject({
        before: { enabled: true, months: 36 },
        after: { enabled: false, months: 12, version: 2 },
      });
    });

    it.each([0, 121, 2.5, '24', null])('refuses %p months and changes nothing', async (months) => {
      expect(await set({ months })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'months', code: 'range' }] }),
      );
      expect(store.settings.size).toBe(0);
      expect(stepUp.spent).toEqual([]);
    });

    it('refuses a stale version (another admin changed it first)', async () => {
      expect((await set({})).ok).toBe(true);
      expect(await set({ expectedVersion: 0 })).toEqual(err({ code: 'conflict.retry' }));
      expect(await set({ expectedVersion: 2 })).toEqual(err({ code: 'conflict.retry' }));
      expect(audit.rows).toHaveLength(1);
    });

    it('refuses without a fresh two-step code, writing nothing', async () => {
      stepUp.proofs = 0;
      expect(await set({})).toEqual(
        err({ code: 'second-factor.required', actionKey: 'ordering.ship-to-retention.change' }),
      );
      expect(store.settings.size).toBe(0);
      expect(audit.rows).toEqual([]);
    });

    it('refuses a caller without the key, a non-admin session and an acting-as session', async () => {
      allowed = false;
      expect(await set({})).toEqual(err({ code: 'access.denied' }));
      expect(await new AdminViewShipToRetention(gate, deps).execute(adminCtx(), {})).toEqual(
        err({ code: 'access.denied' }),
      );
      allowed = true;
      expect(await set({}, adminCtx('customer'))).toEqual(err({ code: 'access.denied' }));
      const actingAs = {
        ...adminCtx(),
        actor: { ...adminCtx().actor, actingAs: { adminAccountId: ADMIN } },
      } as unknown as CallContext;
      expect(await set({}, actingAs)).toEqual(err({ code: 'access.denied' }));
      expect(store.settings.size).toBe(0);
    });

    it('declares a protected manage key and an unprotected view key', () => {
      expect(ORDERING_SHIP_TO_RETENTION_MANAGE.protected).toBe(true);
      expect(ORDERING_SHIP_TO_RETENTION_VIEW.protected).toBe(false);
      expect(AdminSetShipToRetention.access.rule).toEqual({
        kind: 'permissions',
        allOf: ['ordering.ship-to-retention.manage'],
      });
      expect(PurgeDeliveredShipTo.access.rule).toEqual({ kind: 'system' });
    });
  });

  describe('the daily purge', () => {
    it('does nothing while never set or off', async () => {
      const old = order(['2020-01-01T00:00:00']);
      expect(await purge()).toEqual({ ok: true, value: { outcome: 'disabled', cleared: 0 } });
      expect((await set({ enabled: false })).ok).toBe(true);
      audit.rows.length = 0;
      expect(await purge()).toEqual({ ok: true, value: { outcome: 'disabled', cleared: 0 } });
      expect(old.shipTo).toBe(SHIP_TO);
      expect(store.batches).toEqual([]);
      expect(audit.rows).toEqual([]);
    });

    it("clears an order delivered 24 months ago in the Market's zone, not 23 months and 29 days", async () => {
      expect((await set({ enabled: true, months: 24 })).ok).toBe(true);
      audit.rows.length = 0;
      const due = order(['2024-11-15T03:00:00']);
      const early = order(['2024-11-16T03:00:00']);
      expect(await purge()).toEqual({ ok: true, value: { outcome: 'complete', cleared: 1 } });
      expect(due.shipTo).toBeNull();
      expect(early.shipTo).toBe(SHIP_TO);
      expect(audit.rows).toEqual([
        expect.objectContaining({
          action: 'ordering.ship-to.purged',
          targetType: 'ordering.ship-to-retention',
          after: {
            months: 24,
            cutoff: local('2024-11-15T03:00:00'),
            cleared: 1,
            complete: true,
          },
        }),
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain(due.id);
    });

    it('leaves an order with one seller order not delivered, or delivered too recently', async () => {
      expect((await set({ months: 24 })).ok).toBe(true);
      const undelivered = order(['2021-01-01T00:00:00', null]);
      const recent = order(['2021-01-01T00:00:00', '2026-01-01T00:00:00']);
      const both = order(['2021-01-01T00:00:00', '2022-06-01T00:00:00']);
      expect(await purge()).toEqual({ ok: true, value: { outcome: 'complete', cleared: 1 } });
      expect(undelivered.shipTo).toBe(SHIP_TO);
      expect(recent.shipTo).toBe(SHIP_TO);
      expect(both.shipTo).toBeNull();
    });

    it('is idempotent: a second run clears nothing more and says so', async () => {
      expect((await set({ months: 1 })).ok).toBe(true);
      order(['2026-01-01T00:00:00']);
      order(['2026-02-01T00:00:00']);
      expect(await purge()).toEqual({ ok: true, value: { outcome: 'complete', cleared: 2 } });
      expect(await purge()).toEqual({ ok: true, value: { outcome: 'complete', cleared: 0 } });
      expect(store.orders.every((o) => o.shipTo === null)).toBe(true);
      const runs = audit.rows.filter((row) => row.action === 'ordering.ship-to.purged');
      expect(runs.map((row) => (row.after as { cleared: number }).cleared)).toEqual([2, 0]);
    });

    it('works in batches of 500, each after the cursor of the one before', async () => {
      expect((await set({ months: 1 })).ok).toBe(true);
      for (let n = 0; n < 1001; n += 1) order(['2025-01-01T00:00:00']);
      expect(await purge()).toEqual({ ok: true, value: { outcome: 'complete', cleared: 1001 } });
      expect(store.batches.map((b) => [b.limit, b.after === null])).toEqual([
        [500, true],
        [500, false],
        [500, false],
      ]);
      expect(SHIP_TO_PURGE_MAX_BATCHES).toBe(100);
    });

    it("never reaches another Market's orders", async () => {
      expect((await set({ months: 1 })).ok).toBe(true);
      const other = { ...order(['2020-01-01T00:00:00']) };
      store.orders.pop();
      const foreign = { ...other, marketId: code === 'AU' ? 'ZZ' : 'AU' };
      store.orders.push(foreign);
      expect(await purge()).toEqual({ ok: true, value: { outcome: 'complete', cleared: 0 } });
      expect(foreign.shipTo).toBe(SHIP_TO);
    });
  });
});
