import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import { otherMarketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Inventory slice 2, migration inventory_stock: the constraints and grants of the outbox, the
// stock items, the ledger, the availability signals and the retirement tombstones
// (docs/design/data/inventory.md 2, 3.1, 3.4, 3.5, 3.9, 3.10, 7), as the application role, for
// both Market fixtures. The statements are plain SQL on purpose: this file proves the database
// refuses what the application would never send, so a later bug cannot write it either.

const T0 = Temporal.Instant.from('2026-10-08T10:00:00Z');
const at = (seconds: number): string => T0.add({ seconds }).toString();
const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const DENIED = '42501';

describe.each(TEST_MARKETS)(
  'inventory stock constraints in market %s (database integration)',
  (code) => {
    const otherCode = otherMarketOf(code);
    const ids = new UuidV7IdGenerator(new FixedClock(T0));
    const account = ids.next<'Account'>();
    let app: Client;

    beforeAll(async () => {
      app = new Client({ connectionString: testDatabaseUrl() });
      await app.connect();
    });
    afterAll(async () => {
      await app.end();
    });

    /** The constraint named by the last refusal, or null (a privilege error names none). */
    let lastConstraint: string | null = null;

    /** The SQLSTATE of a statement that must fail, or null when it succeeded. */
    async function sqlState(text: string, values: unknown[] = []): Promise<string | null> {
      lastConstraint = null;
      try {
        await app.query(text, values);
        return null;
      } catch (error) {
        const failure = error as { code?: string; constraint?: string };
        lastConstraint = failure.constraint ?? null;
        return failure.code ?? 'unknown';
      }
    }

    /** The last statement was refused with `code` by exactly the constraint `constraint`. */
    function refusedBy(state: string | null, code: string, constraint: string): void {
      expect({ state, constraint: lastConstraint }).toEqual({ state: code, constraint });
    }

    async function insert(table: string, row: Record<string, unknown>): Promise<string | null> {
      const columns = Object.keys(row);
      return sqlState(
        `INSERT INTO inventory.${table} (${columns.join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        Object.values(row),
      );
    }

    /** A seller inventory with one source, in `market`. */
    async function newSource(market: string = code, sellerId = ids.next<'Seller'>()) {
      expect(
        await insert('seller_inventories', {
          id: ids.next(),
          market_id: market,
          tenant_id: 'default',
          seller_id: sellerId,
          version: 1,
          created_at: at(0),
        }),
      ).toBeNull();
      const sourceId = ids.next<'InventorySource'>();
      expect(
        await insert('sources', {
          id: sourceId,
          market_id: market,
          tenant_id: 'default',
          seller_id: sellerId,
          name: 'Default',
          is_default: true,
          priority: 1,
          created_at: at(0),
        }),
      ).toBeNull();
      return { sellerId, sourceId };
    }

    const itemRow = (
      source: { sellerId: string; sourceId: string },
      overrides: Record<string, unknown> = {},
    ) => ({
      id: ids.next(),
      market_id: code,
      tenant_id: 'default',
      offer_id: ids.next(),
      variant_id: ids.next(),
      source_id: source.sourceId,
      seller_id: source.sellerId,
      on_hand: 5,
      version: 1,
      created_at: at(0),
      ...overrides,
    });

    async function newItem(source: { sellerId: string; sourceId: string }, overrides = {}) {
      const row = itemRow(source, overrides);
      expect(await insert('stock_items', row)).toBeNull();
      return row;
    }

    const movementRow = (
      item: { id: string; offer_id: string; variant_id: string },
      overrides: Record<string, unknown> = {},
    ) => ({
      id: ids.next(),
      market_id: code,
      tenant_id: 'default',
      stock_item_id: item.id,
      offer_id: item.offer_id,
      variant_id: item.variant_id,
      delta: 5,
      resulting_on_hand: 5,
      reason: 'seller-set',
      actor_kind: 'account',
      actor_account_id: account,
      correlation_id: 'corr-0000001',
      occurred_at: at(1),
      ...overrides,
    });

    /** Insert a row that one named CHECK, UNIQUE key or foreign key must refuse. */
    async function refuse(
      table: string,
      row: Record<string, unknown>,
      code: string,
      constraint: string,
    ): Promise<void> {
      refusedBy(await insert(table, row), code, constraint);
    }
    const check = (table: string, row: Record<string, unknown>, constraint: string) =>
      refuse(table, row, CHECK, constraint);

    /** The malformed Market and tenant of every table are refused by that table's own CHECK. */
    async function refuseMalformedScope(table: string, row: () => Record<string, unknown>) {
      await check(table, { ...row(), market_id: 'au' }, `${table}_market_id_check`);
      await check(table, { ...row(), market_id: 'A' }, `${table}_market_id_check`);
      await check(table, { ...row(), tenant_id: 'Default' }, `${table}_tenant_id_check`);
      await check(table, { ...row(), tenant_id: '' }, `${table}_tenant_id_check`);
    }

    describe('outbox (3.1)', () => {
      const outboxRow = (overrides: Record<string, unknown> = {}) => ({
        event_id: ids.next(),
        type: 'inventory.low-stock-reached.v1',
        occurred_at: at(0),
        market_id: code,
        tenant_id: 'default',
        aggregate_type: 'availability-signal',
        aggregate_id: ids.next(),
        aggregate_version: 1,
        correlation_id: 'corr-0000001',
        payload: '{}',
        ...overrides,
      });

      it('accepts an inventory event and refuses another module’s type or a look-alike', async () => {
        expect(await insert('outbox', outboxRow())).toBeNull();
        await check('outbox', outboxRow({ type: 'catalog.offer-created.v1' }), 'outbox_type_check');
        await check('outbox', outboxRow({ type: 'inventoryXlow-stock.v1' }), 'outbox_type_check');
        await check(
          'outbox',
          outboxRow({ type: 'inventory.low-stock-reached.v0' }),
          'outbox_type_check',
        );
      });

      it('refuses a malformed Market, tenant, aggregate, correlation id or payload', async () => {
        await refuseMalformedScope('outbox', outboxRow);
        await check(
          'outbox',
          outboxRow({ aggregate_type: 'Signal' }),
          'outbox_aggregate_type_check',
        );
        await check(
          'outbox',
          outboxRow({ aggregate_version: 0 }),
          'outbox_aggregate_version_check',
        );
        await check(
          'outbox',
          outboxRow({ correlation_id: 'short' }),
          'outbox_correlation_id_check',
        );
        await check('outbox', outboxRow({ payload: '[]' }), 'outbox_payload_check');
      });

      it('keeps one event per aggregate version in a Market, and the same pair in each apart', async () => {
        const first = outboxRow();
        expect(await insert('outbox', first)).toBeNull();
        await refuse(
          'outbox',
          outboxRow({ aggregate_id: first.aggregate_id }),
          UNIQUE,
          'outbox_market_id_aggregate_id_aggregate_version_key',
        );
        expect(
          await insert(
            'outbox',
            outboxRow({ aggregate_id: first.aggregate_id, market_id: otherCode }),
          ),
        ).toBeNull();
      });

      it('lets the relay mark published_at and nothing else', async () => {
        const row = outboxRow();
        expect(await insert('outbox', row)).toBeNull();
        const where = `WHERE market_id = '${code}' AND event_id = $1`;
        expect(
          await sqlState(`UPDATE inventory.outbox SET published_at = $2 ${where}`, [
            row.event_id,
            at(5),
          ]),
        ).toBeNull();
        for (const set of ["payload = '{}'", "market_id = 'AU'", `aggregate_version = 9`]) {
          expect(
            await sqlState(`UPDATE inventory.outbox SET ${set} ${where}`, [row.event_id]),
          ).toBe(DENIED);
        }
        expect(await sqlState(`DELETE FROM inventory.outbox ${where}`, [row.event_id])).toBe(
          DENIED,
        );
      });
    });

    describe('stock_items (3.4)', () => {
      it('keeps one item per Offer, Variant and source, in each Market apart', async () => {
        const source = await newSource();
        const row = await newItem(source);
        await refuse(
          'stock_items',
          itemRow(source, { offer_id: row.offer_id, variant_id: row.variant_id }),
          UNIQUE,
          'stock_items_market_id_offer_id_variant_id_source_id_key',
        );
        // Another source of the same seller holds the same sell unit.
        const secondSource = { ...source, sourceId: ids.next<'InventorySource'>() };
        expect(
          await insert('sources', {
            id: secondSource.sourceId,
            market_id: code,
            tenant_id: 'default',
            seller_id: source.sellerId,
            name: 'Second',
            is_default: false,
            priority: 2,
            created_at: at(0),
          }),
        ).toBeNull();
        expect(
          await insert(
            'stock_items',
            itemRow(secondSource, { offer_id: row.offer_id, variant_id: row.variant_id }),
          ),
        ).toBeNull();
        // The same Offer and Variant ids in the other Market do not collide.
        const otherSource = await newSource(otherCode);
        expect(
          await insert(
            'stock_items',
            itemRow(otherSource, {
              market_id: otherCode,
              offer_id: row.offer_id,
              variant_id: row.variant_id,
            }),
          ),
        ).toBeNull();
      });

      it('refuses a negative level, a version below 1 and a malformed Market or tenant', async () => {
        const source = await newSource();
        await check('stock_items', itemRow(source, { on_hand: -1 }), 'stock_items_on_hand_check');
        await check('stock_items', itemRow(source, { version: 0 }), 'stock_items_version_check');
        await refuseMalformedScope('stock_items', () => itemRow(source));
        expect(await insert('stock_items', itemRow(source, { on_hand: 0 }))).toBeNull();
      });

      it('proves the item’s seller is its source’s seller, and its Market too', async () => {
        const source = await newSource();
        await refuse(
          'stock_items',
          itemRow(source, { seller_id: ids.next() }),
          FOREIGN_KEY,
          'stock_items_market_id_source_id_seller_id_fkey',
        );
        await refuse(
          'stock_items',
          itemRow(source, { market_id: otherCode }),
          FOREIGN_KEY,
          'stock_items_market_id_source_id_seller_id_fkey',
        );
      });

      it('lets a stock write change the level, retirement and version, and nothing else', async () => {
        const source = await newSource();
        const row = await newItem(source);
        const where = `WHERE market_id = '${code}' AND id = $1`;
        expect(
          await sqlState(
            `UPDATE inventory.stock_items SET on_hand = 9, version = 2, retired_at = $2 ${where}`,
            [row.id, at(3)],
          ),
        ).toBeNull();
        refusedBy(
          await sqlState(`UPDATE inventory.stock_items SET on_hand = -1 ${where}`, [row.id]),
          CHECK,
          'stock_items_on_hand_check',
        );
        refusedBy(
          await sqlState(`UPDATE inventory.stock_items SET version = 0 ${where}`, [row.id]),
          CHECK,
          'stock_items_version_check',
        );
        for (const column of [
          'id',
          'market_id',
          'tenant_id',
          'offer_id',
          'variant_id',
          'source_id',
          'seller_id',
          'created_at',
        ]) {
          const value =
            column === 'created_at'
              ? at(9)
              : column === 'market_id'
                ? otherCode
                : column === 'tenant_id'
                  ? 'other'
                  : ids.next();
          expect(
            await sqlState(`UPDATE inventory.stock_items SET ${column} = $2 ${where}`, [
              row.id,
              value,
            ]),
          ).toBe(DENIED);
        }
        expect(await sqlState(`DELETE FROM inventory.stock_items ${where}`, [row.id])).toBe(DENIED);
      });

      it('lets the application lock an item with FOR NO KEY UPDATE under the column grant', async () => {
        const source = await newSource();
        const row = await newItem(source);
        await app.query('BEGIN');
        try {
          const { rows } = await app.query(
            `SELECT id FROM inventory.stock_items
              WHERE market_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE`,
            [code, [row.id]],
          );
          expect(rows).toHaveLength(1);
        } finally {
          await app.query('ROLLBACK');
        }
      });
    });

    describe('stock_movements (3.5)', () => {
      const moduleActor = {
        actor_kind: 'module',
        actor_account_id: null,
        actor_module: 'inventory',
      };

      it('records a movement and keeps the ledger append-only', async () => {
        const item = await newItem(await newSource());
        const row = movementRow(item);
        expect(await insert('stock_movements', row)).toBeNull();
        const where = `WHERE market_id = '${code}' AND id = $1`;
        for (const set of [
          'delta = 1',
          'resulting_on_hand = 1',
          "reason = 'restock'",
          'occurred_at = now()',
        ]) {
          expect(
            await sqlState(`UPDATE inventory.stock_movements SET ${set} ${where}`, [row.id]),
          ).toBe(DENIED);
        }
        expect(await sqlState(`DELETE FROM inventory.stock_movements ${where}`, [row.id])).toBe(
          DENIED,
        );
      });

      it('refuses a zero delta and a level that was or would be negative', async () => {
        const item = await newItem(await newSource());
        await check(
          'stock_movements',
          movementRow(item, { delta: 0 }),
          'stock_movements_delta_check',
        );
        await check(
          'stock_movements',
          movementRow(item, { delta: 3, resulting_on_hand: 2 }),
          'stock_movements_resulting_on_hand_check',
        );
        await check(
          'stock_movements',
          movementRow(item, { delta: -3, resulting_on_hand: -1 }),
          'stock_movements_resulting_on_hand_check',
        );
        expect(
          await insert('stock_movements', movementRow(item, { delta: -3, resulting_on_hand: 2 })),
        ).toBeNull();
      });

      it('refuses a malformed Market or tenant', async () => {
        const item = await newItem(await newSource());
        await refuseMalformedScope('stock_movements', () => movementRow(item));
      });

      it('accepts only the four reasons', async () => {
        const item = await newItem(await newSource());
        expect(
          await insert('stock_movements', movementRow(item, { reason: 'restock' })),
        ).toBeNull();
        await check(
          'stock_movements',
          movementRow(item, { reason: 'adjustment' }),
          'stock_movements_reason_check',
        );
      });

      it('ties the actor columns to the actor kind', async () => {
        const item = await newItem(await newSource());
        await check(
          'stock_movements',
          movementRow(item, { actor_kind: 'system', actor_account_id: null }),
          'stock_movements_actor_kind_check',
        );
        await check(
          'stock_movements',
          movementRow(item, { actor_account_id: null }),
          'stock_movements_actor_account_id_check',
        );
        await check(
          'stock_movements',
          movementRow(item, { actor_module: 'inventory' }),
          'stock_movements_actor_module_check',
        );
        expect(await insert('stock_movements', movementRow(item, moduleActor))).toBeNull();
        await check(
          'stock_movements',
          movementRow(item, { ...moduleActor, actor_module: 'Inventory' }),
          'stock_movements_actor_module_check',
        );
        await check(
          'stock_movements',
          movementRow(item, { ...moduleActor, actor_account_id: account }),
          'stock_movements_actor_account_id_check',
        );
      });

      it('lets only a module actor write a shipment or a re-key, and anyone a seller-set', async () => {
        const item = await newItem(await newSource());
        for (const reason of ['shipment', 're-key']) {
          await check(
            'stock_movements',
            movementRow(item, { reason }),
            'stock_movements_system_reason_check',
          );
          expect(
            await insert('stock_movements', movementRow(item, { reason, ...moduleActor })),
          ).toBeNull();
        }
        expect(
          await insert('stock_movements', movementRow(item, { reason: 'seller-set' })),
        ).toBeNull();
      });

      it('proves the Offer, Variant and Market equal the item’s, and the item exists', async () => {
        const item = await newItem(await newSource());
        const fkey = 'stock_movements_market_id_stock_item_id_offer_id_variant_i_fkey';
        await refuse(
          'stock_movements',
          movementRow(item, { offer_id: ids.next() }),
          FOREIGN_KEY,
          fkey,
        );
        await refuse(
          'stock_movements',
          movementRow(item, { variant_id: ids.next() }),
          FOREIGN_KEY,
          fkey,
        );
        await refuse(
          'stock_movements',
          movementRow(item, { market_id: otherCode }),
          FOREIGN_KEY,
          fkey,
        );
        await refuse(
          'stock_movements',
          movementRow(item, { stock_item_id: ids.next() }),
          FOREIGN_KEY,
          fkey,
        );
      });

      it('refuses a malformed correlation id', async () => {
        const item = await newItem(await newSource());
        for (const correlation_id of ['short', 'has space in it', 'x'.repeat(129)]) {
          await check(
            'stock_movements',
            movementRow(item, { correlation_id }),
            'stock_movements_correlation_id_check',
          );
        }
        expect(
          await insert('stock_movements', movementRow(item, { correlation_id: 'x'.repeat(128) })),
        ).toBeNull();
      });
    });

    describe('availability_signals (3.9)', () => {
      const signalRow = (overrides: Record<string, unknown> = {}) => ({
        id: ids.next(),
        market_id: code,
        tenant_id: 'default',
        offer_id: ids.next(),
        variant_id: ids.next(),
        seller_id: ids.next(),
        status: 'in-stock',
        changed_at: at(0),
        version: 1,
        ...overrides,
      });

      it('ties only_left to the low status, within 1 to 99', async () => {
        const only = 'availability_signals_only_left_check';
        expect(
          await insert('availability_signals', signalRow({ status: 'low', only_left: 3 })),
        ).toBeNull();
        await check('availability_signals', signalRow({ status: 'low' }), only);
        await check('availability_signals', signalRow({ only_left: 3 }), only);
        await check('availability_signals', signalRow({ status: 'out', only_left: 1 }), only);
        await check('availability_signals', signalRow({ status: 'low', only_left: 0 }), only);
        await check('availability_signals', signalRow({ status: 'low', only_left: 100 }), only);
        await check(
          'availability_signals',
          signalRow({ status: 'unknown' }),
          'availability_signals_status_check',
        );
        await check(
          'availability_signals',
          signalRow({ version: 0 }),
          'availability_signals_version_check',
        );
      });

      it('refuses a malformed Market or tenant', async () => {
        await refuseMalformedScope('availability_signals', signalRow);
      });

      it('keeps one signal per sell unit in a Market, and lets only the state columns change', async () => {
        const row = signalRow();
        expect(await insert('availability_signals', row)).toBeNull();
        await refuse(
          'availability_signals',
          signalRow({ offer_id: row.offer_id, variant_id: row.variant_id }),
          UNIQUE,
          'availability_signals_market_id_offer_id_variant_id_key',
        );
        expect(
          await insert(
            'availability_signals',
            signalRow({
              offer_id: row.offer_id,
              variant_id: row.variant_id,
              market_id: otherCode,
            }),
          ),
        ).toBeNull();
        const where = `WHERE market_id = '${code}' AND id = $1`;
        expect(
          await sqlState(
            `UPDATE inventory.availability_signals SET status = 'out', version = 2, changed_at = $2 ${where}`,
            [row.id, at(4)],
          ),
        ).toBeNull();
        // The state columns stay consistent with each other on update, too.
        refusedBy(
          await sqlState(`UPDATE inventory.availability_signals SET status = 'low' ${where}`, [
            row.id,
          ]),
          CHECK,
          'availability_signals_only_left_check',
        );
        refusedBy(
          await sqlState(`UPDATE inventory.availability_signals SET version = 0 ${where}`, [
            row.id,
          ]),
          CHECK,
          'availability_signals_version_check',
        );
        for (const column of [
          'id',
          'market_id',
          'tenant_id',
          'offer_id',
          'variant_id',
          'seller_id',
        ]) {
          const value =
            column === 'market_id' ? otherCode : column === 'tenant_id' ? 'other' : ids.next();
          expect(
            await sqlState(`UPDATE inventory.availability_signals SET ${column} = $2 ${where}`, [
              row.id,
              value,
            ]),
          ).toBe(DENIED);
        }
        expect(
          await sqlState(`DELETE FROM inventory.availability_signals ${where}`, [row.id]),
        ).toBe(DENIED);
      });
    });

    describe('retirements (3.10)', () => {
      const retirementRow = (overrides: Record<string, unknown> = {}) => ({
        id: ids.next(),
        market_id: code,
        tenant_id: 'default',
        scope: 'offer',
        offer_id: ids.next() as string | null,
        variant_id: null as string | null,
        source_aggregate_version: 2,
        retired_at: at(0),
        ...overrides,
      });

      /** A Variant tombstone is keyed by the Variant alone: no Offer (migration 3). */
      const variantTombstone = (overrides: Record<string, unknown> = {}) =>
        retirementRow({ scope: 'variant', offer_id: null, variant_id: ids.next(), ...overrides });

      it('ties the Variant id to the variant scope and the Offer id to the offer scope', async () => {
        const variant = 'retirements_variant_id_check';
        const offer = 'retirements_offer_id_check';
        await check('retirements', retirementRow({ variant_id: ids.next() }), variant);
        await check('retirements', variantTombstone({ variant_id: null }), variant);
        await check('retirements', retirementRow({ offer_id: null }), offer);
        await check('retirements', variantTombstone({ offer_id: ids.next() }), offer);
        expect(await insert('retirements', variantTombstone())).toBeNull();
        await check(
          'retirements',
          // No Offer id, so that the Offer id rule above does not refuse the row first.
          retirementRow({ scope: 'sell-unit', offer_id: null }),
          'retirements_scope_check',
        );
        await check(
          'retirements',
          retirementRow({ source_aggregate_version: 0 }),
          'retirements_source_aggregate_version_check',
        );
      });

      it('refuses a malformed Market or tenant', async () => {
        await refuseMalformedScope('retirements', retirementRow);
      });

      it('keeps one tombstone per Offer and one per Variant, in each Market apart', async () => {
        const offerRow = retirementRow();
        expect(await insert('retirements', offerRow)).toBeNull();
        await refuse(
          'retirements',
          retirementRow({ offer_id: offerRow.offer_id }),
          UNIQUE,
          'retirements_market_id_offer_id_offer_key',
        );
        expect(
          await insert(
            'retirements',
            retirementRow({ offer_id: offerRow.offer_id, market_id: otherCode }),
          ),
        ).toBeNull();
        const variantRow = variantTombstone();
        expect(await insert('retirements', variantRow)).toBeNull();
        await refuse(
          'retirements',
          variantTombstone({ variant_id: variantRow.variant_id }),
          UNIQUE,
          'retirements_market_id_variant_id_variant_key',
        );
        expect(
          await insert(
            'retirements',
            variantTombstone({ variant_id: variantRow.variant_id, market_id: otherCode }),
          ),
        ).toBeNull();
        // An Offer tombstone and a Variant tombstone sit side by side.
        expect(await insert('retirements', variantTombstone())).toBeNull();
      });

      it('lets a tombstone be cleared but never edited', async () => {
        const row = variantTombstone();
        expect(await insert('retirements', row)).toBeNull();
        const where = `WHERE market_id = '${code}' AND id = $1`;
        for (const set of [
          'source_aggregate_version = 3',
          'retired_at = now()',
          "scope = 'offer'",
          'variant_id = NULL',
          `offer_id = '${ids.next()}'`,
        ]) {
          expect(await sqlState(`UPDATE inventory.retirements SET ${set} ${where}`, [row.id])).toBe(
            DENIED,
          );
        }
        expect(await sqlState(`DELETE FROM inventory.retirements ${where}`, [row.id])).toBeNull();
      });
    });
  },
);
