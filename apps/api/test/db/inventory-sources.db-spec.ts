import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { SellerRegistered } from '../../src/modules/identity';
import { PrismaSellerInventoryRepository } from '../../src/modules/inventory/infrastructure/prisma-seller-inventory.repository';
import {
  DEFAULT_SOURCE_NAME,
  SellerInventory,
} from '../../src/modules/inventory/domain/seller-inventory';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { eventContext, ids } from './outbox-support';
import { createPersistence, marketOf, modelMap, type Persistence } from './persistence-support';
import { inventoryOwnerTestDatabaseUrl, inventoryTestDatabaseUrl } from './test-database';

// Inventory slice 1 on PostgreSQL (inventory design 3.4; data design 3.1 to 3.3, 7), for both
// Market fixtures: an `identity.seller-registered.v1` event is written to identity's outbox, the
// relay and the dispatcher run `inventory.ensure-seller-inventory` through the real unit of work
// and inbox, and the rows, the constraints and the grants are read back as the application role.
// This file runs on its own copy of the run database (global-setup.ts): the relay and the
// dispatcher claim every due row of a Market. The other subscribers of the event run too; the
// event names no account, so they find nothing to do.

const OCCURRED_AT = Temporal.Instant.from('2026-10-08T10:00:00Z');

describe.each(TEST_MARKETS)('inventory sources in market %s (database integration)', (code) => {
  const other = code === 'AU' ? 'ZZ' : 'AU';
  const market = marketOf(code);
  let app: NestExpressApplication;
  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let relay: OutboxRelay;
  let dispatcher: EventDispatcher;
  let logs: jest.SpyInstance[];

  const catalogue = new EventCatalogue();
  catalogue.register('identity', [SellerRegistered]);
  catalogue.seal();

  beforeAll(async () => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    sql = new Client({ connectionString: inventoryTestDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: inventoryOwnerTestDatabaseUrl() });
    await owner.connect();
    db = createPersistence({ databaseUrl: inventoryTestDatabaseUrl() });
    ({ app } = await createTestApp({ env: { DATABASE_URL: inventoryTestDatabaseUrl() } }));
    relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
  });
  afterAll(async () => {
    await app.close();
    await db.close();
    await sql.end();
    await owner.end();
    logs.forEach((spy) => spy.mockRestore());
  });

  const newSeller = () => ids.next<'Seller'>();

  async function settle(): Promise<void> {
    for (;;) {
      const published = (await relay.runOnce()).published;
      const claimed = (await dispatcher.runOnce()).claimed;
      if (published === 0 && claimed === 0) return;
    }
  }

  /** Writes `identity.seller-registered.v1` to identity's outbox, as its use case does, and settles. */
  async function registered(
    marketCode: string,
    sellerId: Id<'Seller'>,
    accessState: 'pending' | 'approved' | 'rejected' | 'suspended' = 'approved',
    version = 1,
  ): Promise<void> {
    const target = marketOf(marketCode);
    const writer = new PrismaOutboxWriterFactory(
      modelMap,
      db.service,
      catalogue,
      ids,
      NO_PERMISSION_KEYS,
    ).forModule('identity');
    await db.unitOfWork.run(target, async () => {
      await writer.append(eventContext(target), [
        SellerRegistered.record({
          aggregateId: sellerId,
          aggregateVersion: version,
          occurredAt: OCCURRED_AT,
          payload: { sellerId, ownerAccountId: null, origin: 'self', accessState },
        }),
      ]);
      return ok(undefined);
    });
    await settle();
  }

  const inventoryOf = async (marketCode: string, sellerId: string) =>
    (
      await sql.query<Record<string, unknown>>(
        `SELECT seller_id, market_id, tenant_id, low_stock_threshold, version
           FROM inventory.seller_inventories WHERE market_id = $1 AND seller_id = $2`,
        [marketCode, sellerId],
      )
    ).rows;
  const sourcesOf = async (marketCode: string, sellerId: string) =>
    (
      await sql.query<Record<string, unknown>>(
        `SELECT name, address, time_zone, is_default, priority, tenant_id
           FROM inventory.sources WHERE market_id = $1 AND seller_id = $2 ORDER BY priority`,
        [marketCode, sellerId],
      )
    ).rows;
  const handledInventoryEvents = async (marketCode: string) =>
    (
      await sql.query(
        `SELECT 1 FROM inventory.inbox WHERE market_id = $1
            AND handler = 'inventory.ensure-seller-inventory'`,
        [marketCode],
      )
    ).rowCount!;

  it('creates the inventory with its Default source and the inbox row for an approved seller, once', async () => {
    const sellerId = newSeller();
    const handledBefore = await handledInventoryEvents(code);

    await registered(code, sellerId);

    expect(await inventoryOf(code, sellerId)).toEqual([
      {
        seller_id: sellerId,
        market_id: code,
        tenant_id: market.tenantId,
        low_stock_threshold: null,
        version: 1,
      },
    ]);
    expect(await sourcesOf(code, sellerId)).toEqual([
      {
        name: DEFAULT_SOURCE_NAME,
        address: null,
        time_zone: null,
        is_default: true,
        priority: 1,
        tenant_id: market.tenantId,
      },
    ]);
    expect(await handledInventoryEvents(code)).toBe(handledBefore + 1);

    // A second approval, as another event for the same seller (re-apply, reinstate), finds the
    // inventory and does nothing (AC 10); a pass with nothing new changes nothing.
    await registered(code, sellerId, 'approved', 2);
    await settle();
    expect(await inventoryOf(code, sellerId)).toHaveLength(1);
    expect(await sourcesOf(code, sellerId)).toHaveLength(1);
    expect(await handledInventoryEvents(code)).toBe(handledBefore + 2);
  });

  it.each(['pending', 'rejected', 'suspended'] as const)(
    'settles the delivery and writes no inventory for a seller that is %s',
    async (state) => {
      const sellerId = newSeller();
      const handledBefore = await handledInventoryEvents(code);

      await registered(code, sellerId, state);

      expect(await inventoryOf(code, sellerId)).toHaveLength(0);
      expect(await sourcesOf(code, sellerId)).toHaveLength(0);
      // The handler ran: one inbox row, and the delivery is delivered, not backed off for a retry.
      expect(await handledInventoryEvents(code)).toBe(handledBefore + 1);
      const delivery = await sql.query(
        `SELECT status, error_code FROM platform.event_delivery
          WHERE subscriber = 'inventory.ensure-seller-inventory' AND market_id = $1
            AND aggregate_id = $2`,
        [code, sellerId],
      );
      expect(delivery.rows).toEqual([{ status: 'delivered', error_code: null }]);
    },
  );

  it('creates the inventory when the approved event follows a pending one for the same seller', async () => {
    const sellerId = newSeller();

    await registered(code, sellerId, 'pending', 1);
    await registered(code, sellerId, 'approved', 2);

    expect(await inventoryOf(code, sellerId)).toHaveLength(1);
    expect(await sourcesOf(code, sellerId)).toHaveLength(1);
  });

  it('keeps a separate inventory per Market for the same seller id', async () => {
    const sellerId = newSeller();

    await registered(code, sellerId);
    await registered(other, sellerId);

    expect(await inventoryOf(code, sellerId)).toHaveLength(1);
    expect(await inventoryOf(other, sellerId)).toHaveLength(1);
    expect(await sourcesOf(other, sellerId)).toHaveLength(1);
  });

  it('converges when two creations race for one seller: one inventory, one Default source', async () => {
    const sellerId = newSeller();
    const repository = new PrismaSellerInventoryRepository(db.service);
    const attempt = () =>
      db.unitOfWork.run(market, async () =>
        ok(
          await repository.add(
            market,
            SellerInventory.createWithDefaultSource({
              id: ids.next<'SellerInventory'>(),
              defaultSourceId: ids.next<'InventorySource'>(),
              sellerId,
              marketId: market.marketId,
              now: OCCURRED_AT,
            }),
          ),
        ),
      );

    const results = await Promise.all([attempt(), attempt(), attempt()]);

    expect(results.map((result) => result.ok && result.value).sort()).toEqual([false, false, true]);
    expect(await inventoryOf(code, sellerId)).toHaveLength(1);
    expect(await sourcesOf(code, sellerId)).toHaveLength(1);
  });

  describe('the seller changes its sources (part 2)', () => {
    const repository = () => new PrismaSellerInventoryRepository(db.service);
    const load = async (sellerId: Id<'Seller'>, target = market) => {
      const found = await db.unitOfWork.run(
        target,
        async () => ok(await repository().findBySeller(target, sellerId)),
        { readOnly: true },
      );
      return found.ok ? found.value : null;
    };
    const mutate = (
      sellerId: Id<'Seller'>,
      change: (inventory: SellerInventory) => SellerInventory,
      target = market,
    ) =>
      db.unitOfWork.run(target, async () => {
        const loaded = await repository().findBySeller(target, sellerId);
        return ok(await repository().save(target, change(loaded!)));
      });
    const addTo = (
      inventory: SellerInventory,
      name: string,
      address = null as null | Record<string, string>,
    ) => {
      const added = inventory.addSource({
        id: ids.next<'InventorySource'>(),
        name,
        address,
        timeZone: address === null ? null : 'Australia/Brisbane',
        maxSources: 4,
        now: OCCURRED_AT,
      });
      if (!added.ok) throw new Error('unexpected');
      return added.value;
    };

    it('loads nothing for a seller without an inventory, and nothing across Markets', async () => {
      const sellerId = newSeller();
      expect(await load(sellerId)).toBeNull();
      await registered(code, sellerId);
      expect(await load(sellerId)).not.toBeNull();
      expect(await load(sellerId, marketOf(other))).toBeNull();
    });

    it('adds a source last with its address and zone, and raises the version', async () => {
      const sellerId = newSeller();
      await registered(code, sellerId);
      const result = await mutate(sellerId, (i) =>
        addTo(i, 'Garage', { line1: '1 Test St', suburb: 'Brisbane' }),
      );
      expect(result).toEqual({ ok: true, value: 'saved' });
      expect((await inventoryOf(code, sellerId))[0]).toMatchObject({ version: 2 });
      expect(await sourcesOf(code, sellerId)).toEqual([
        expect.objectContaining({ name: 'Default', priority: 1, address: null }),
        expect.objectContaining({
          name: 'Garage',
          priority: 2,
          address: { line1: '1 Test St', suburb: 'Brisbane' },
          time_zone: 'Australia/Brisbane',
          is_default: false,
        }),
      ]);
      const loaded = await load(sellerId);
      expect(loaded!.state.sources.map((x) => x.name)).toEqual(['Default', 'Garage']);
      expect(loaded!.state.sources[1]!.address).toEqual({ line1: '1 Test St', suburb: 'Brisbane' });
    });

    it('edits name, address and zone, and clears the address with null', async () => {
      const sellerId = newSeller();
      await registered(code, sellerId);
      const edit = (name: string, address: Record<string, string> | null) =>
        mutate(sellerId, (i) => {
          const edited = i.editSource({
            sourceId: i.state.sources[0]!.id,
            name,
            address,
            timeZone: address === null ? null : 'Australia/Perth',
          });
          if (!edited.ok) throw new Error('unexpected');
          return edited.value;
        });
      await edit('Main shed', { line1: '2 Test St' });
      expect((await sourcesOf(code, sellerId))[0]).toMatchObject({
        name: 'Main shed',
        address: { line1: '2 Test St' },
        time_zone: 'Australia/Perth',
        is_default: true,
      });
      await edit('Main shed', null);
      expect((await sourcesOf(code, sellerId))[0]).toMatchObject({
        address: null,
        time_zone: null,
      });
    });

    it('reorders in two passes against the unique position key, with no gap or duplicate', async () => {
      const sellerId = newSeller();
      await registered(code, sellerId);
      for (const name of ['A', 'B', 'C']) {
        await mutate(sellerId, (i) => addTo(i, name));
      }
      const before = (await load(sellerId))!;
      const [d, a, b, c] = before.state.sources.map((x) => x.id);
      const result = await mutate(sellerId, (i) => {
        const reordered = i.reorder([c!, b!, d!, a!]);
        if (!reordered.ok) throw new Error('unexpected');
        return reordered.value;
      });
      expect(result).toEqual({ ok: true, value: 'saved' });
      expect((await sourcesOf(code, sellerId)).map((x) => [x.name, x.priority])).toEqual([
        ['C', 1],
        ['B', 2],
        ['Default', 3],
        ['A', 4],
      ]);
      expect((await inventoryOf(code, sellerId))[0]).toMatchObject({
        version: before.state.version + 1,
      });
    });

    it('answers stale, writing nothing, when another edit raised the version in between', async () => {
      const sellerId = newSeller();
      await registered(code, sellerId);
      const loaded = (await load(sellerId))!;
      await mutate(sellerId, (i) => addTo(i, 'First'));
      const result = await db.unitOfWork.run(market, async () =>
        ok(await repository().save(market, addTo(loaded, 'Second'))),
      );
      expect(result).toEqual({ ok: true, value: 'stale' });
      expect((await sourcesOf(code, sellerId)).map((x) => x.name)).toEqual(['Default', 'First']);
    });

    it('lets exactly one of two concurrent adds win, the other seeing stale', async () => {
      const sellerId = newSeller();
      await registered(code, sellerId);
      const loaded = (await load(sellerId))!;
      const attempt = (name: string) =>
        db.unitOfWork.run(market, async () =>
          ok(await repository().save(market, addTo(loaded, name))),
        );
      const results = await Promise.all([attempt('X'), attempt('Y')]);
      expect(results.map((r) => r.ok && r.value).sort()).toEqual(['saved', 'stale']);
      expect(await sourcesOf(code, sellerId)).toHaveLength(2);
      expect((await inventoryOf(code, sellerId))[0]).toMatchObject({ version: 2 });
    });

    it('rolls the whole change back when a later statement fails (version and sources together)', async () => {
      const sellerId = newSeller();
      await registered(code, sellerId);
      const loaded = (await load(sellerId))!;
      const failing = await db.unitOfWork
        .run(market, async () => {
          await repository().save(market, addTo(loaded, 'Doomed'));
          throw new Error('boom');
        })
        .catch((error: unknown) => error);
      expect(failing).toBeInstanceOf(Error);
      expect((await inventoryOf(code, sellerId))[0]).toMatchObject({ version: 1 });
      expect(await sourcesOf(code, sellerId)).toHaveLength(1);
    });
  });

  describe('what the database refuses (data design 3.3, 7)', () => {
    const insertSource = (
      sellerId: string,
      fields: { name?: string; priority?: number; isDefault?: boolean; marketId?: string },
    ) =>
      sql.query(
        `INSERT INTO inventory.sources (id, market_id, tenant_id, seller_id, name, is_default,
           priority, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
          randomUUID(),
          fields.marketId ?? code,
          market.tenantId,
          sellerId,
          fields.name ?? 'Warehouse',
          fields.isDefault ?? false,
          fields.priority ?? 2,
        ],
      );

    it('a second Default source, a repeated position, a bad name and a source in another Market', async () => {
      const sellerId = newSeller();
      await registered(code, sellerId);

      await expect(insertSource(sellerId, { isDefault: true })).rejects.toMatchObject({
        code: '23505',
        constraint: 'sources_market_id_seller_id_default_key',
      });
      await expect(insertSource(sellerId, { priority: 1 })).rejects.toMatchObject({
        code: '23505',
        constraint: 'sources_market_id_seller_id_priority_key',
      });
      for (const name of [' padded', '', 'x'.repeat(81)]) {
        await expect(insertSource(sellerId, { name })).rejects.toMatchObject({
          code: '23514',
          constraint: 'sources_name_check',
        });
      }
      await expect(insertSource(sellerId, { priority: 0 })).rejects.toMatchObject({
        code: '23514',
        constraint: 'sources_priority_check',
      });
      // The foreign key leads with market_id: a source of this seller in another Market has no parent.
      await expect(insertSource(sellerId, { marketId: other })).rejects.toMatchObject({
        code: '23503',
        constraint: 'sources_market_id_seller_id_fkey',
      });
      // A second, non-Default source at the next position is fine.
      await insertSource(sellerId, { name: 'Warehouse', priority: 2 });
      expect(await sourcesOf(code, sellerId)).toHaveLength(2);
    });

    it('a bad time zone or address, and the widest accepted time zone form', async () => {
      const sellerId = newSeller();
      await registered(code, sellerId);
      const update = (set: string) =>
        sql.query(`UPDATE inventory.sources SET ${set} WHERE seller_id = $1`, [sellerId]);

      for (const zone of ['Australia/', '1bad']) {
        await expect(update(`time_zone = '${zone}'`)).rejects.toMatchObject({
          code: '23514',
          constraint: 'sources_time_zone_check',
        });
      }
      await expect(update(`address = '[]'::jsonb`)).rejects.toMatchObject({
        code: '23514',
        constraint: 'sources_address_check',
      });
      await update(`time_zone = 'America/Argentina/Buenos_Aires'`);
      await update(`name = '${'x'.repeat(80)}'`);
    });

    it('a threshold outside 0 to 99, a version below 1, and a handler of another module', async () => {
      const sellerId = newSeller();
      await registered(code, sellerId);

      await expect(
        sql.query(
          'UPDATE inventory.seller_inventories SET low_stock_threshold = 100 WHERE seller_id = $1',
          [sellerId],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'seller_inventories_low_stock_threshold_check',
      });
      await expect(
        sql.query(
          'UPDATE inventory.seller_inventories SET low_stock_threshold = -1 WHERE seller_id = $1',
          [sellerId],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'seller_inventories_low_stock_threshold_check',
      });
      await expect(
        sql.query('UPDATE inventory.seller_inventories SET version = 0 WHERE seller_id = $1', [
          sellerId,
        ]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'seller_inventories_version_check' });
      await expect(
        sql.query(
          `INSERT INTO inventory.inbox (event_id, handler, market_id, tenant_id, processed_at)
           VALUES ($1, 'sellers.create-file', $2, $3, now())`,
          [randomUUID(), code, market.tenantId],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'inbox_handler_check' });
    });

    it('a delete, and a change to the owner, the Default flag or the Market', async () => {
      const sellerId = newSeller();
      await registered(code, sellerId);

      await expect(
        sql.query('DELETE FROM inventory.sources WHERE seller_id = $1', [sellerId]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql.query('DELETE FROM inventory.seller_inventories WHERE seller_id = $1', [sellerId]),
      ).rejects.toMatchObject({ code: '42501' });
      for (const column of ['is_default = false', 'seller_id = gen_random_uuid()']) {
        await expect(
          sql.query(`UPDATE inventory.sources SET ${column} WHERE seller_id = $1`, [sellerId]),
        ).rejects.toMatchObject({ code: '42501' });
      }
      await expect(
        sql.query('UPDATE inventory.sources SET market_id = $2 WHERE seller_id = $1', [
          sellerId,
          other,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql.query('UPDATE inventory.seller_inventories SET seller_id = $2 WHERE seller_id = $1', [
          sellerId,
          randomUUID(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      // The columns the design names stay editable.
      await sql.query(
        `UPDATE inventory.sources SET name = 'Main', time_zone = 'Australia/Brisbane',
           address = '{"line":"1 Example St"}', priority = 1 WHERE seller_id = $1`,
        [sellerId],
      );
      await sql.query(
        'UPDATE inventory.seller_inventories SET low_stock_threshold = 5, version = 2 WHERE seller_id = $1',
        [sellerId],
      );
      expect((await sourcesOf(code, sellerId))[0]).toMatchObject({
        name: 'Main',
        time_zone: 'Australia/Brisbane',
      });
    });

    it('a row without its Market and tenant: both are required, with no default', async () => {
      await expect(
        owner.query(
          `INSERT INTO inventory.seller_inventories (id, seller_id, version, created_at)
           VALUES ($1, $2, 1, now())`,
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '23502' });
    });
  });
});
