import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { FleetSelectionModel } from '../../src/modules/shipping/domain/fleet-selection';
import { PrismaFleetSelectionRepository } from '../../src/modules/shipping/infrastructure/prisma-fleet-selection.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The fleet-selection models, the active model per method and the reliability scores
// (shipping.fleet_selection_models, _assignments and fleet_reliability) as the application role,
// in both Market fixtures: insert, the case-insensitive name, the versioned save, the active
// model, the scores, the Market guard, and what the database refuses.

const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const CHECK = '23514';
const DENIED = '42501';

describe.each(TEST_MARKETS)('fleet selection repository in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const admin = ids.next<'Account'>();
  let db: Persistence;
  let repository: PrismaFleetSelectionRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    repository = new PrismaFleetSelectionRepository(db.service);
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
  const model = (name: string, patch: Partial<FleetSelectionModel> = {}): FleetSelectionModel => ({
    id: ids.next<'FleetSelectionModel'>(),
    name,
    rule: { kind: 'cheapest' },
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  });
  const unique = (label: string) => `${label} ${ids.next<'Account'>().slice(-8)}`;

  it('stores a model, reads it back in its Market only and refuses a name taken in any case', async () => {
    const name = unique('Cheapest');
    const first = model(name, {
      rule: { kind: 'weighted', weights: { price: 50, eta: 30, reliability: 20 } },
    });
    expect(await value(market, () => repository.insertModel(market, first, admin))).toBe(
      'inserted',
    );
    expect(
      await value(market, () => repository.insertModel(market, model(name.toUpperCase()), admin)),
    ).toBe('name-taken');
    // The same name is free in the other Market.
    expect(await value(other, () => repository.insertModel(other, model(name), admin))).toBe(
      'inserted',
    );

    expect(await value(market, () => repository.findModel(market, first.id))).toEqual(first);
    expect(await value(other, () => repository.findModel(other, first.id))).toBeNull();
    expect((await value(market, () => repository.listModels(market))).map((m) => m.id)).toContain(
      first.id,
    );
  });

  it('saves an edit only at the expected version and keeps names unique', async () => {
    const a = model(unique('Alpha'));
    const b = model(unique('Beta'));
    await value(market, () => repository.insertModel(market, a, admin));
    await value(market, () => repository.insertModel(market, b, admin));

    const edited: FleetSelectionModel = {
      ...a,
      rule: { kind: 'fixed_priority', order: ['zoom2u', 'mondapac_drive'] },
      version: 2,
      updatedAt: T0.add({ minutes: 1 }),
    };
    expect(await value(market, () => repository.saveModel(market, edited, 1, admin))).toBe('saved');
    expect(await value(market, () => repository.saveModel(market, edited, 1, admin))).toBe(
      'conflict',
    );
    expect(await value(other, () => repository.saveModel(other, edited, 2, admin))).toBe(
      'conflict',
    );
    expect(
      await value(market, () =>
        repository.saveModel(
          market,
          { ...edited, name: b.name.toLowerCase(), version: 3 },
          2,
          admin,
        ),
      ),
    ).toBe('name-taken');
    expect(await value(market, () => repository.findModel(market, a.id))).toEqual(edited);
  });

  it('makes a model active per method, goes back to the default and reads the rule', async () => {
    const chosen = model(unique('Fixed'), {
      rule: { kind: 'fixed_priority', order: ['uber_direct', 'mondapac_drive'] },
    });
    await value(market, () => repository.insertModel(market, chosen, admin));

    await value(market, () => repository.assign(market, 'instant', chosen.id, admin, T0));
    expect((await value(market, () => repository.assignments(market))).get('instant')).toBe(
      chosen.id,
    );
    expect(await value(market, () => repository.activeRule(market, 'instant'))).toEqual(
      chosen.rule,
    );
    expect(await value(market, () => repository.activeRule(market, 'scheduled'))).toBeNull();
    expect((await value(other, () => repository.assignments(other))).get('instant')).not.toBe(
      chosen.id,
    );

    await value(market, () => repository.assign(market, 'instant', null, admin, T0));
    expect((await value(market, () => repository.assignments(market))).has('instant')).toBe(false);
    expect(await value(market, () => repository.activeRule(market, 'instant'))).toBeNull();
  });

  it('keeps one reliability score per fleet and Market', async () => {
    await value(market, () => repository.setReliability(market, 'zoom2u', 70, admin, T0));
    await value(market, () => repository.setReliability(market, 'zoom2u', 85, admin, T0));
    await value(other, () => repository.setReliability(other, 'zoom2u', 10, admin, T0));

    expect((await value(market, () => repository.reliabilities(market))).get('zoom2u')).toBe(85);
    expect((await value(other, () => repository.reliabilities(other))).get('zoom2u')).toBe(10);
  });

  it('refuses what the application never writes', async () => {
    const attempt = (text: string, params: unknown[]) =>
      sql.query(text, params).then(
        () => 'allowed',
        (error: { code?: string }) => error.code,
      );
    const score = (fleet: string, value: number) =>
      attempt(
        `INSERT INTO shipping.fleet_reliability (market_id, tenant_id, fleet, score, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [market.marketId, market.tenantId, fleet, value, admin],
      );
    expect(await score('unknown_fleet', 50)).toBe(CHECK);
    expect(await score('auspost', 101)).toBe(CHECK);
    expect(await score('auspost', -1)).toBe(CHECK);
    expect(
      await attempt(
        `INSERT INTO shipping.fleet_selection_models (id, market_id, tenant_id, name, kind, rule, version, created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'x', 'cheapest', '{"kind":"weighted"}', 1, $4, $4, now(), now())`,
        [ids.next<'FleetSelectionModel'>(), market.marketId, market.tenantId, admin],
      ),
    ).toBe(CHECK);
    expect(await attempt(`DELETE FROM shipping.fleet_selection_models`, [])).toBe(DENIED);
    expect(await attempt(`DELETE FROM shipping.fleet_reliability`, [])).toBe(DENIED);
  });
});
