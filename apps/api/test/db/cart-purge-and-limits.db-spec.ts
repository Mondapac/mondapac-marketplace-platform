import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PurgeInactiveCarts } from '../../src/modules/cart/application/use-cases/purge-inactive-carts.use-case';
import { transferToAccount, type CartState } from '../../src/modules/cart/domain/cart';
import {
  GUEST_CREATE_ORIGIN,
  GUEST_WRITE_CART,
  rateVerdict,
} from '../../src/modules/cart/domain/rate-limits';
import { ConfigCartPolicy } from '../../src/modules/cart/infrastructure/config-cart-policy';
import { CryptoGuestTokens } from '../../src/modules/cart/infrastructure/crypto-guest-tokens';
import { HmacRateCounterKeys } from '../../src/modules/cart/infrastructure/hmac-rate-counter-keys';
import { PrismaCartRepository } from '../../src/modules/cart/infrastructure/prisma-cart.repository';
import { PrismaRateCounterRepository } from '../../src/modules/cart/infrastructure/prisma-rate-counter.repository';
import { PrismaSavedItemRepository } from '../../src/modules/cart/infrastructure/prisma-saved-item.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The purge job and the guest rate counters of the cart on PostgreSQL, as the application role,
// for both Market fixtures: expiry by kind (7 days for guest and merged carts, 90 for account
// carts), the other Market's carts untouched, lines by the cascade, batches ordered by
// `last_changed_at`; the fixed-window counters keyed by a hash; the transfer race as `stale`.
// The clock sits in 2020 so the carts of the other files (2026) are never expired by this run.

const NOW = Temporal.Instant.from('2020-03-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

describe.each(TEST_MARKETS)(
  'cart purge and guest rate counters in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    const currency = code === 'AU' ? 'AUD' : 'JPY';
    const clock = new FixedClock(NOW);
    const ids = new UuidV7IdGenerator(
      new FixedClock(Temporal.Instant.from('2026-10-09T10:00:00Z')),
    );
    const tokens = new CryptoGuestTokens();
    const keys = new HmacRateCounterKeys(new Uint8Array(32).fill(5));
    let db: Persistence;
    let carts: PrismaCartRepository;
    let counters: PrismaRateCounterRepository;
    let saved: PrismaSavedItemRepository;
    let purge: PurgeInactiveCarts;
    let sql: Client;

    beforeAll(async () => {
      db = createPersistence();
      carts = new PrismaCartRepository(db.service);
      counters = new PrismaRateCounterRepository(db.service);
      saved = new PrismaSavedItemRepository(db.service);
      purge = new PurgeInactiveCarts(gate, {
        unitOfWork: db.unitOfWork,
        carts,
        counters,
        saved,
        policy: new ConfigCartPolicy(markets),
        clock,
      });
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
    });
    afterAll(async () => {
      await db.close();
      await sql.end();
    });

    beforeEach(async () => {
      clock.set(NOW);
      // Only the 2020 rows of this file: nothing else sits that far back.
      await sql.query(`DELETE FROM cart.carts WHERE last_changed_at < '2021-01-01'`);
      await sql.query(`DELETE FROM cart.rate_counters WHERE window_started_at < '2021-01-01'`);
      await sql.query(`DELETE FROM cart.saved_items WHERE saved_at < '2021-01-01'`);
    });

    const unit = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
      const result = await db.unitOfWork.run(target, async () => ok(await work()));
      if (!result.ok) throw new Error('unit failed');
      return result.value;
    };
    const system = () => testCallContext(market, 'system', 'cart-purge-0001');
    const cartAged = (
      target: MarketContext,
      owner: 'guest' | 'account' | 'merged',
      ageDays: number,
    ): CartState => {
      const changed = NOW.subtract({ milliseconds: Math.round(ageDays * DAY) });
      const merged = owner === 'merged';
      return {
        id: ids.next<'Cart'>(),
        marketId: target.marketId,
        owner:
          owner === 'account'
            ? { kind: 'account', accountId: ids.next<'Account'>() }
            : { kind: 'guest', tokenHash: tokens.issue().hash },
        status: merged ? 'merged' : 'active',
        lastChangedAt: changed,
        mergedIntoCartId: merged ? ids.next<'Cart'>() : null,
        mergedAt: merged ? changed : null,
        version: 1,
        createdAt: changed.subtract({ hours: 1 }),
        lines: [
          {
            id: ids.next<'CartLine'>(),
            offerId: ids.next<'Offer'>(),
            variantId: ids.next<'Variant'>(),
            quantity: 1,
            priceAtAdd: money(1000n, currency),
            addedAt: changed,
          },
        ],
      };
    };
    const exists = async (cart: CartState): Promise<boolean> =>
      (await sql.query(`SELECT 1 FROM cart.carts WHERE id = $1`, [cart.id])).rowCount === 1;
    const linesOf = async (cart: CartState): Promise<number> =>
      (await sql.query(`SELECT 1 FROM cart.cart_lines WHERE cart_id = $1`, [cart.id])).rowCount ??
      0;

    it('deletes expired guest, merged and account carts with their lines, keeps fresh ones, in two Markets', async () => {
      const mine = {
        guestOld: cartAged(market, 'guest', 7.5),
        guestFresh: cartAged(market, 'guest', 6.5),
        mergedOld: cartAged(market, 'merged', 8),
        accountOld: cartAged(market, 'account', 91),
        accountFresh: cartAged(market, 'account', 89),
        accountSevenDays: cartAged(market, 'account', 10),
      };
      const theirs = {
        guestOld: cartAged(other, 'guest', 30),
        accountOld: cartAged(other, 'account', 200),
      };
      for (const cart of Object.values(mine)) await unit(market, () => carts.insert(market, cart));
      for (const cart of Object.values(theirs)) await unit(other, () => carts.insert(other, cart));

      const done = await purge.execute(system(), {});

      expect(done).toEqual({ ok: true, value: { carts: 3, rateCounters: 0, savedItems: 0 } });
      expect(await exists(mine.guestOld)).toBe(false);
      expect(await linesOf(mine.guestOld)).toBe(0);
      expect(await exists(mine.mergedOld)).toBe(false);
      expect(await exists(mine.accountOld)).toBe(false);
      expect(await exists(mine.guestFresh)).toBe(true);
      expect(await linesOf(mine.guestFresh)).toBe(1);
      expect(await exists(mine.accountFresh)).toBe(true);
      expect(await exists(mine.accountSevenDays)).toBe(true);
      // The other Market is purged only by its own run.
      expect(await exists(theirs.guestOld)).toBe(true);
      expect(await exists(theirs.accountOld)).toBe(true);
      const theirRun = await purge.execute(testCallContext(other, 'system', 'cart-purge-0002'), {});
      expect(theirRun).toEqual({ ok: true, value: { carts: 2, rateCounters: 0, savedItems: 0 } });
      expect(await exists(theirs.guestOld)).toBe(false);
    });

    it('saves for an account only, moves a saved-again unit to the top, and purges a year on', async () => {
      const account = ids.next<'Account'>();
      const otherAccount = ids.next<'Account'>();
      const unitOf = { offerId: ids.next<'Offer'>(), variantId: ids.next<'Variant'>() };
      const item = (accountId: typeof account, ageDays: number, sellUnit = unitOf) => ({
        id: ids.next<'SavedItem'>(),
        accountId,
        ...sellUnit,
        savedAt: NOW.subtract({ milliseconds: Math.round(ageDays * DAY) }),
      });
      const first = await unit(market, () => saved.upsert(market, item(account, 400)));
      const fresh = await unit(market, () =>
        saved.upsert(market, item(account, 10, { offerId: ids.next(), variantId: ids.next() })),
      );
      await unit(market, () => saved.upsert(market, item(otherAccount, 400)));
      await unit(other, () => saved.upsert(other, item(account, 400)));

      // Saving the same unit again keeps its row and moves it to the top.
      const again = await unit(market, () => saved.upsert(market, item(account, 1)));
      expect(again.id).toBe(first.id);
      const list = await unit(market, () => saved.list(market, account, 100));
      expect(list.map((row) => row.id)).toEqual([first.id, fresh.id]);
      expect(await unit(market, () => saved.count(market, account))).toBe(2);
      // Another account's id is unknown to this one.
      expect(await unit(market, () => saved.find(market, otherAccount, first.id))).toBeNull();
      expect(await unit(market, () => saved.delete(market, otherAccount, first.id))).toBe(false);

      const done = await purge.execute(system(), {});

      // Only this Market's item last saved over a year ago went (the other account's).
      expect(done.ok && done.value.savedItems).toBe(1);
      expect(await unit(market, () => saved.count(market, account))).toBe(2);
      expect(await unit(market, () => saved.count(market, otherAccount))).toBe(0);
      expect(await unit(other, () => saved.count(other, account))).toBe(1);
      expect(await unit(market, () => saved.delete(market, account, first.id))).toBe(true);
    });

    it('purges in batches of 200, oldest first, and a second run finds nothing', async () => {
      const batch = Array.from({ length: 205 }, (_, n) => cartAged(market, 'guest', 8 + n / 1000));
      for (const cart of batch) await unit(market, () => carts.insert(market, cart));

      const first = await unit(market, () =>
        carts.purgeInactive(
          market,
          NOW.subtract({ milliseconds: 7 * DAY }),
          NOW.subtract({ milliseconds: 90 * DAY }),
          200,
        ),
      );
      const left = await sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM cart.carts WHERE last_changed_at < '2021-01-01'`,
      );
      expect(first).toBe(200);
      expect(left.rows[0]!.n).toBe(5);
      // The five that stay are the freshest of the batch.
      const freshest = batch.slice(0, 5);
      for (const cart of freshest) expect(await exists(cart)).toBe(true);

      const run = await purge.execute(system(), {});
      expect(run).toEqual({ ok: true, value: { carts: 5, rateCounters: 0, savedItems: 0 } });
      expect(await purge.execute(system(), {})).toEqual({
        ok: true,
        value: { carts: 0, rateCounters: 0, savedItems: 0 },
      });
    });

    it('keeps a cart that was changed after it was selected (the expiry is repeated in the delete)', async () => {
      const cart = cartAged(market, 'guest', 8);
      await unit(market, () => carts.insert(market, cart));
      // Same statement shape as the purge, with the cart refreshed between select and delete.
      await sql.query(`UPDATE cart.carts SET last_changed_at = $2 WHERE id = $1`, [
        cart.id,
        new Date(NOW.epochMilliseconds),
      ]);

      const deleted = await unit(market, () =>
        carts.purgeInactive(
          market,
          NOW.subtract({ milliseconds: 7 * DAY }),
          NOW.subtract({ milliseconds: 90 * DAY }),
          200,
        ),
      );

      expect(deleted).toBe(0);
      expect(await exists(cart)).toBe(true);
    });

    it('counts in PostgreSQL by hashed key, restarts an ended window, throttles over the limit and prunes ended windows', async () => {
      const key = keys.keyOf(market, GUEST_CREATE_ORIGIN.kind, '203.0.113.9');
      const counter = { limit: GUEST_CREATE_ORIGIN, keyHash: key };
      let reserved = await unit(market, () => counters.reserve(market, [counter], NOW));
      for (let n = 0; n < 30; n += 1) {
        reserved = await unit(market, () => counters.reserve(market, [counter], NOW));
      }

      expect(reserved[0]!.count).toBe(31);
      expect(rateVerdict([GUEST_CREATE_ORIGIN], reserved, NOW.add({ minutes: 20 }))).toEqual({
        allowed: false,
        retryAfterSeconds: 40 * 60,
      });
      const stored = await sql.query(
        `SELECT kind, count, octet_length(key_hash) AS bytes FROM cart.rate_counters
        WHERE market_id = $1 AND window_started_at = $2`,
        [code, new Date(NOW.epochMilliseconds)],
      );
      expect(stored.rows).toEqual([{ kind: GUEST_CREATE_ORIGIN.kind, count: 31, bytes: 32 }]);
      expect(JSON.stringify(stored.rows)).not.toContain('203.0.113.9');
      // The same subject in the other Market is another counter.
      const otherKey = keys.keyOf(other, GUEST_CREATE_ORIGIN.kind, '203.0.113.9');
      expect(Buffer.from(otherKey).equals(Buffer.from(key))).toBe(false);

      const later = NOW.add({ minutes: 61 });
      const restarted = await unit(market, () => counters.reserve(market, [counter], later));
      expect(restarted[0]!.count).toBe(1);

      // Two counters in one call come back in the order given.
      const cartKey = keys.keyOf(market, GUEST_WRITE_CART.kind, 'ab'.repeat(32));
      const both = await unit(market, () =>
        counters.reserve(market, [{ limit: GUEST_WRITE_CART, keyHash: cartKey }, counter], later),
      );
      expect(both.map((row) => [row.kind, row.count])).toEqual([
        [GUEST_WRITE_CART.kind, 1],
        [GUEST_CREATE_ORIGIN.kind, 2],
      ]);

      // The purge deletes counters whose window ended more than 60 minutes ago.
      clock.set(later.add({ minutes: 61 }));
      const run = await purge.execute(system(), {});
      expect(run.ok && run.value.rateCounters).toBe(2);
      expect(
        (await sql.query(`SELECT 1 FROM cart.rate_counters WHERE window_started_at < '2021-01-01'`))
          .rowCount,
      ).toBe(0);
    });

    it('refuses a kind outside the closed list and a key that is not 32 bytes', async () => {
      const bad = {
        limit: { ...GUEST_CREATE_ORIGIN, kind: 'guest.other' as never },
        keyHash: new Uint8Array(32),
      };
      await expect(unit(market, () => counters.reserve(market, [bad], NOW))).rejects.toThrow(
        TypeError,
      );
      await expect(
        unit(market, () =>
          counters.reserve(
            market,
            [{ limit: GUEST_CREATE_ORIGIN, keyHash: new Uint8Array(8) }],
            NOW,
          ),
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        sql.query(
          `INSERT INTO cart.rate_counters (market_id, tenant_id, kind, key_hash, window_started_at, count)
         VALUES ($1, 'default', 'guest.other', $2, now(), 1)`,
          [code, Buffer.alloc(32)],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('answers stale, not an error, when the transfer of a guest cart meets the account’s own active cart (L1)', async () => {
      const accountId = ids.next<'Account'>();
      const account: CartState = {
        ...cartAged(market, 'account', 0),
        owner: { kind: 'account', accountId },
      };
      const guest = cartAged(market, 'guest', 0);
      await unit(market, () => carts.insert(market, account));
      await unit(market, () => carts.insert(market, guest));

      const saved = await unit(market, () =>
        carts.save(market, transferToAccount(guest, accountId, NOW)),
      );

      expect(saved).toBe('stale');
      expect(await exists(guest)).toBe(true);
    });

    it('counts parallel first hits and parallel hits on an existing key exactly, with no error', async () => {
      const counter = {
        limit: GUEST_WRITE_CART,
        keyHash: keys.keyOf(market, GUEST_WRITE_CART.kind, 'cd'.repeat(32)),
      };
      const hit = (at: Temporal.Instant) =>
        unit(market, () => counters.reserve(market, [counter], at));

      const first = await Promise.all(Array.from({ length: 10 }, () => hit(NOW)));
      expect(first.map((r) => r[0]!.count).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      const more = await Promise.all(Array.from({ length: 10 }, () => hit(NOW)));
      expect(more.map((r) => r[0]!.count).sort((a, b) => a - b)).toEqual([
        11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);

      // Ten units meet the same ended window: it restarts once, and every attempt after the
      // restart is counted (the window start never moves back).
      const later = NOW.add({ minutes: 20 });
      const reset = await Promise.all(Array.from({ length: 10 }, () => hit(later)));
      expect(reset.map((r) => r[0]!.count).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      const row = await sql.query<{ count: number }>(
        `SELECT count FROM cart.rate_counters WHERE market_id = $1 AND key_hash = $2 AND kind = $3`,
        [code, Buffer.from(counter.keyHash), counter.limit.kind],
      );
      expect(row.rows).toEqual([{ count: 10 }]);
    });
  },
);
