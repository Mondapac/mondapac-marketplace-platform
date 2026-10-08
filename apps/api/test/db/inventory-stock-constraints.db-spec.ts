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

    /** The SQLSTATE of a statement that must fail, or null when it succeeded. */
    async function sqlState(text: string, values: unknown[] = []): Promise<string | null> {
      try {
        await app.query(text, values);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
      }
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
    async function newSource(market = code, sellerId = ids.next<'Seller'>()) {
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

      it('accepts an inventory event and refuses another module’s type', async () => {
        expect(await insert('outbox', outboxRow())).toBeNull();
        expect(await insert('outbox', outboxRow({ type: 'catalog.offer-created.v1' }))).toBe(CHECK);
      });

      it('refuses a second event with the same aggregate version', async () => {
        const first = outboxRow();
        expect(await insert('outbox', first)).toBeNull();
        expect(await insert('outbox', outboxRow({ aggregate_id: first.aggregate_id }))).toBe(
          UNIQUE,
        );
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
        expect(
          await sqlState(`UPDATE inventory.outbox SET payload = '{}' ${where}`, [row.event_id]),
        ).toBe(DENIED);
        expect(await sqlState(`DELETE FROM inventory.outbox ${where}`, [row.event_id])).toBe(
          DENIED,
        );
      });
    });

    describe('stock_items (3.4)', () => {
      it('keeps one item per Offer, Variant and source', async () => {
        const source = await newSource();
        const row = await newItem(source);
        expect(
          await insert(
            'stock_items',
            itemRow(source, { offer_id: row.offer_id, variant_id: row.variant_id }),
          ),
        ).toBe(UNIQUE);
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
      });

      it('refuses a negative level, a version below 1 and a malformed Market or tenant', async () => {
        const source = await newSource();
        expect(await insert('stock_items', itemRow(source, { on_hand: -1 }))).toBe(CHECK);
        expect(await insert('stock_items', itemRow(source, { version: 0 }))).toBe(CHECK);
        expect(await insert('stock_items', itemRow(source, { market_id: 'au' }))).toBe(CHECK);
        expect(await insert('stock_items', itemRow(source, { tenant_id: 'Default' }))).toBe(CHECK);
        expect(await insert('stock_items', itemRow(source, { on_hand: 0 }))).toBeNull();
      });

      it('proves the item’s seller is its source’s seller, and its Market too', async () => {
        const source = await newSource();
        const stranger = ids.next<'Seller'>();
        expect(await insert('stock_items', itemRow(source, { seller_id: stranger }))).toBe(
          FOREIGN_KEY,
        );
        expect(await insert('stock_items', itemRow(source, { market_id: otherCode }))).toBe(
          FOREIGN_KEY,
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
        expect(
          await sqlState(`UPDATE inventory.stock_items SET on_hand = -1 ${where}`, [row.id]),
        ).toBe(CHECK);
        for (const column of ['offer_id', 'variant_id', 'source_id', 'seller_id', 'created_at']) {
          const value = column === 'created_at' ? at(9) : ids.next();
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
      it('records a movement and keeps the ledger append-only', async () => {
        const source = await newSource();
        const item = await newItem(source);
        const row = movementRow(item);
        expect(await insert('stock_movements', row)).toBeNull();
        const where = `WHERE market_id = '${code}' AND id = $1`;
        expect(
          await sqlState(`UPDATE inventory.stock_movements SET delta = 1 ${where}`, [row.id]),
        ).toBe(DENIED);
        expect(await sqlState(`DELETE FROM inventory.stock_movements ${where}`, [row.id])).toBe(
          DENIED,
        );
      });

      it('refuses a zero delta and a level that was or would be negative', async () => {
        const item = await newItem(await newSource());
        expect(await insert('stock_movements', movementRow(item, { delta: 0 }))).toBe(CHECK);
        expect(
          await insert('stock_movements', movementRow(item, { delta: 3, resulting_on_hand: 2 })),
        ).toBe(CHECK);
        expect(
          await insert('stock_movements', movementRow(item, { delta: -3, resulting_on_hand: -1 })),
        ).toBe(CHECK);
        expect(
          await insert('stock_movements', movementRow(item, { delta: -3, resulting_on_hand: 2 })),
        ).toBeNull();
      });

      it('accepts only the four reasons', async () => {
        const item = await newItem(await newSource());
        expect(
          await insert('stock_movements', movementRow(item, { reason: 'restock' })),
        ).toBeNull();
        expect(await insert('stock_movements', movementRow(item, { reason: 'adjustment' }))).toBe(
          CHECK,
        );
      });

      it('ties the actor columns to the actor kind', async () => {
        const item = await newItem(await newSource());
        const module = { actor_kind: 'module', actor_account_id: null, actor_module: 'inventory' };
        expect(await insert('stock_movements', movementRow(item, { actor_account_id: null }))).toBe(
          CHECK,
        );
        expect(
          await insert('stock_movements', movementRow(item, { actor_module: 'inventory' })),
        ).toBe(CHECK);
        expect(await insert('stock_movements', movementRow(item, module))).toBeNull();
        expect(
          await insert(
            'stock_movements',
            movementRow(item, { ...module, actor_module: 'Inventory' }),
          ),
        ).toBe(CHECK);
        expect(
          await insert(
            'stock_movements',
            movementRow(item, { ...module, actor_account_id: account }),
          ),
        ).toBe(CHECK);
      });

      it('lets only the module actor write a shipment or a re-key', async () => {
        const item = await newItem(await newSource());
        const module = { actor_kind: 'module', actor_account_id: null, actor_module: 'ordering' };
        for (const reason of ['shipment', 're-key']) {
          expect(await insert('stock_movements', movementRow(item, { reason }))).toBe(CHECK);
          expect(
            await insert('stock_movements', movementRow(item, { reason, ...module })),
          ).toBeNull();
        }
      });

      it('proves the Offer and Variant copies equal the item’s', async () => {
        const item = await newItem(await newSource());
        expect(await insert('stock_movements', movementRow(item, { offer_id: ids.next() }))).toBe(
          FOREIGN_KEY,
        );
        expect(await insert('stock_movements', movementRow(item, { variant_id: ids.next() }))).toBe(
          FOREIGN_KEY,
        );
        expect(await insert('stock_movements', movementRow(item, { market_id: otherCode }))).toBe(
          FOREIGN_KEY,
        );
      });

      it('refuses a malformed correlation id', async () => {
        const item = await newItem(await newSource());
        expect(
          await insert('stock_movements', movementRow(item, { correlation_id: 'short' })),
        ).toBe(CHECK);
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
        expect(
          await insert('availability_signals', signalRow({ status: 'low', only_left: 3 })),
        ).toBeNull();
        expect(await insert('availability_signals', signalRow({ status: 'low' }))).toBe(CHECK);
        expect(await insert('availability_signals', signalRow({ only_left: 3 }))).toBe(CHECK);
        expect(
          await insert('availability_signals', signalRow({ status: 'out', only_left: 1 })),
        ).toBe(CHECK);
        expect(
          await insert('availability_signals', signalRow({ status: 'low', only_left: 0 })),
        ).toBe(CHECK);
        expect(
          await insert('availability_signals', signalRow({ status: 'low', only_left: 100 })),
        ).toBe(CHECK);
        expect(await insert('availability_signals', signalRow({ status: 'unknown' }))).toBe(CHECK);
      });

      it('keeps one signal per sell unit and lets only the state columns change', async () => {
        const row = signalRow();
        expect(await insert('availability_signals', row)).toBeNull();
        expect(
          await insert(
            'availability_signals',
            signalRow({ offer_id: row.offer_id, variant_id: row.variant_id }),
          ),
        ).toBe(UNIQUE);
        const where = `WHERE market_id = '${code}' AND id = $1`;
        expect(
          await sqlState(
            `UPDATE inventory.availability_signals SET status = 'out', version = 2, changed_at = $2 ${where}`,
            [row.id, at(4)],
          ),
        ).toBeNull();
        expect(
          await sqlState(`UPDATE inventory.availability_signals SET seller_id = $2 ${where}`, [
            row.id,
            ids.next(),
          ]),
        ).toBe(DENIED);
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
        offer_id: ids.next(),
        source_aggregate_version: 2,
        retired_at: at(0),
        ...overrides,
      });

      it('ties the Variant id to the variant scope', async () => {
        expect(await insert('retirements', retirementRow({ variant_id: ids.next() }))).toBe(CHECK);
        expect(await insert('retirements', retirementRow({ scope: 'variant' }))).toBe(CHECK);
        expect(
          await insert('retirements', retirementRow({ scope: 'variant', variant_id: ids.next() })),
        ).toBeNull();
        expect(await insert('retirements', retirementRow({ scope: 'sell-unit' }))).toBe(CHECK);
        expect(await insert('retirements', retirementRow({ source_aggregate_version: 0 }))).toBe(
          CHECK,
        );
      });

      it('keeps one tombstone per Offer and one per Variant, in each Market apart', async () => {
        const offerRow = retirementRow();
        expect(await insert('retirements', offerRow)).toBeNull();
        expect(await insert('retirements', retirementRow({ offer_id: offerRow.offer_id }))).toBe(
          UNIQUE,
        );
        expect(
          await insert(
            'retirements',
            retirementRow({ offer_id: offerRow.offer_id, market_id: otherCode }),
          ),
        ).toBeNull();
        const variantRow = retirementRow({ scope: 'variant', variant_id: ids.next() });
        expect(await insert('retirements', variantRow)).toBeNull();
        expect(
          await insert(
            'retirements',
            retirementRow({
              scope: 'variant',
              offer_id: variantRow.offer_id,
              variant_id: variantRow.variant_id,
            }),
          ),
        ).toBe(UNIQUE);
        // An Offer tombstone and a Variant tombstone of the same Offer sit side by side.
        expect(
          await insert(
            'retirements',
            retirementRow({
              scope: 'variant',
              offer_id: offerRow.offer_id,
              variant_id: ids.next(),
            }),
          ),
        ).toBeNull();
      });

      it('lets a tombstone be cleared but never edited', async () => {
        const row = retirementRow();
        expect(await insert('retirements', row)).toBeNull();
        const where = `WHERE market_id = '${code}' AND id = $1`;
        expect(
          await sqlState(`UPDATE inventory.retirements SET source_aggregate_version = 3 ${where}`, [
            row.id,
          ]),
        ).toBe(DENIED);
        expect(await sqlState(`DELETE FROM inventory.retirements ${where}`, [row.id])).toBeNull();
      });
    });
  },
);
