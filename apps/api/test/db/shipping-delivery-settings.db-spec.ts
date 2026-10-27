import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  DEFAULT_DELIVERY_SETTINGS,
  type DeliverySettingsInput,
} from '../../src/modules/shipping/domain/delivery-settings';
import { PrismaDeliverySettingsRepository } from '../../src/modules/shipping/infrastructure/prisma-delivery-settings.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The delivery settings of a Market and the methods taken away from a seller
// (shipping.delivery_settings, shipping.seller_delivery_methods) as the application role, in both
// Market fixtures: the defaults, the first save and the versioned ones, the three margin kinds,
// the Market guard, the methods of a seller, and what the database refuses.

const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const CHECK = '23514';
const DENIED = '42501';

const input = (patch: Partial<DeliverySettingsInput> = {}): DeliverySettingsInput => ({
  enabled: { pickup: true, instant: false, same_day: true, scheduled: true },
  sameDayCutoffMinutes: 630,
  scheduledDaysAhead: 5,
  scheduledWindowMinutes: 90,
  margin: { kind: 'percent', basisPoints: 1250 },
  roundingStepMinor: 5,
  ...patch,
});

describe.each(TEST_MARKETS)('delivery settings repository in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const admin = ids.next<'Account'>();
  let db: Persistence;
  let repository: PrismaDeliverySettingsRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    repository = new PrismaDeliverySettingsRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  it('reads the defaults while nothing is saved, then the first save, then versioned saves', async () => {
    // A Market of this file that has never saved reads the defaults (version 0).
    const fresh = await value(market, () => repository.settings(market));
    if (fresh.version === 0) expect(fresh).toEqual(DEFAULT_DELIVERY_SETTINGS);

    const base = fresh.version;
    const first = await value(market, () =>
      repository.saveSettings(market, input(), base, admin, T0),
    );
    expect(first).toEqual({ ...input(), version: base + 1 });
    expect(await value(market, () => repository.settings(market))).toEqual({
      ...input(),
      version: base + 1,
    });

    // A save at a stale version (or a second "first" save) is a conflict and changes nothing.
    expect(
      await value(market, () =>
        repository.saveSettings(market, input({ scheduledDaysAhead: 2 }), base, admin, T0),
      ),
    ).toBe('conflict');
    expect((await value(market, () => repository.settings(market))).scheduledDaysAhead).toBe(5);

    const second = await value(market, () =>
      repository.saveSettings(
        market,
        input({ margin: { kind: 'fixed', amountMinor: 150 }, roundingStepMinor: 100 }),
        base + 1,
        admin,
        T0.add({ minutes: 1 }),
      ),
    );
    expect(second).toMatchObject({
      margin: { kind: 'fixed', amountMinor: 150 },
      version: base + 2,
    });

    const none = await value(market, () =>
      repository.saveSettings(
        market,
        input({ margin: { kind: 'none' }, roundingStepMinor: 1 }),
        base + 2,
        admin,
        T0,
      ),
    );
    expect(none).toMatchObject({
      margin: { kind: 'none' },
      roundingStepMinor: 1,
      version: base + 3,
    });
    expect(await value(market, () => repository.settings(market))).toMatchObject({
      margin: { kind: 'none' },
      version: base + 3,
    });
  });

  it('keeps the settings of one Market out of the other', async () => {
    const mine = await value(market, () => repository.settings(market));
    const theirs = await value(other, () => repository.settings(other));
    const saved = await value(other, () =>
      repository.saveSettings(other, input({ scheduledDaysAhead: 9 }), theirs.version, admin, T0),
    );
    expect(saved).toMatchObject({ scheduledDaysAhead: 9 });
    expect(await value(market, () => repository.settings(market))).toEqual(mine);
  });

  it('keeps the methods taken away from a seller, per seller and Market', async () => {
    const a = ids.next<'Seller'>();
    const b = ids.next<'Seller'>();
    expect((await value(market, () => repository.unsupportedOf(market, [a, b]))).size).toBe(0);

    await value(market, () =>
      repository.setUnsupported(market, a, ['instant', 'same_day'], admin, T0),
    );
    await value(other, () => repository.setUnsupported(other, a, ['pickup'], admin, T0));
    const read = await value(market, () => repository.unsupportedOf(market, [a, b]));
    expect([...read]).toEqual([[a, ['instant', 'same_day']]]);
    expect([...(await value(other, () => repository.unsupportedOf(other, [a])))]).toEqual([
      [a, ['pickup']],
    ]);

    await value(market, () =>
      repository.setUnsupported(market, a, [], admin, T0.add({ minutes: 1 })),
    );
    expect([...(await value(market, () => repository.unsupportedOf(market, [a])))]).toEqual([
      [a, []],
    ]);
    expect((await value(market, () => repository.unsupportedOf(market, []))).size).toBe(0);
  });

  it('refuses what the application never writes', async () => {
    const attempt = (text: string, params: unknown[]) =>
      sql.query(text, params).then(
        () => 'allowed',
        (error: { code?: string }) => error.code,
      );
    const settings = (patch: Record<string, unknown>) => {
      const row = {
        market_id: 'XX',
        pickup_enabled: true,
        instant_enabled: true,
        same_day_enabled: true,
        scheduled_enabled: true,
        same_day_cutoff_minutes: 720,
        scheduled_days_ahead: 7,
        scheduled_window_minutes: 120,
        margin_kind: 'none',
        margin_basis_points: null,
        margin_fixed_minor: null,
        rounding_step_minor: 1,
        version: 1,
        ...patch,
      };
      const keys = Object.keys(row);
      return attempt(
        `INSERT INTO shipping.delivery_settings (${keys.join(', ')}, tenant_id, updated_by, updated_at)
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, 'default', $${keys.length + 1}, now())`,
        [...Object.values(row), admin],
      );
    };
    expect(await settings({ same_day_cutoff_minutes: 1440 })).toBe(CHECK);
    expect(await settings({ same_day_cutoff_minutes: -1 })).toBe(CHECK);
    expect(await settings({ scheduled_days_ahead: 0 })).toBe(CHECK);
    expect(await settings({ scheduled_days_ahead: 31 })).toBe(CHECK);
    expect(await settings({ scheduled_window_minutes: 20 })).toBe(CHECK);
    expect(await settings({ scheduled_window_minutes: 100 })).toBe(CHECK);
    expect(await settings({ rounding_step_minor: 25 })).toBe(CHECK);
    expect(await settings({ margin_kind: 'percent' })).toBe(CHECK);
    expect(await settings({ margin_kind: 'none', margin_fixed_minor: 5 })).toBe(CHECK);
    expect(await settings({ margin_kind: 'percent', margin_basis_points: 10001 })).toBe(CHECK);
    expect(await settings({ margin_kind: 'fixed', margin_fixed_minor: 1000001 })).toBe(CHECK);
    expect(await settings({ margin_kind: 'weird' })).toBe(CHECK);
    expect(await settings({ version: 0 })).toBe(CHECK);
    expect(await settings({ market_id: 'xx' })).toBe(CHECK);
    const seller = ids.next<'Seller'>();
    expect(
      await attempt(
        `INSERT INTO shipping.seller_delivery_methods (market_id, tenant_id, seller_id, unsupported, updated_by, updated_at)
         VALUES ($1, $2, $3, ARRAY['drone'], $4, now())`,
        [market.marketId, market.tenantId, seller, admin],
      ),
    ).toBe(CHECK);
    expect(await attempt(`DELETE FROM shipping.delivery_settings`, [])).toBe(DENIED);
    expect(await attempt(`DELETE FROM shipping.seller_delivery_methods`, [])).toBe(DENIED);
  });
});
