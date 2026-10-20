import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { CartState } from '../../src/modules/cart/domain/cart';
import { CryptoGuestTokens } from '../../src/modules/cart/infrastructure/crypto-guest-tokens';
import { PrismaCartRepository } from '../../src/modules/cart/infrastructure/prisma-cart.repository';
import { PrismaCartReminderRepository } from '../../src/modules/notifications/infrastructure/prisma-cart-reminder.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Personalization 1c on PostgreSQL, as the application role, for both Market fixtures: the idle
// account carts the cart reminder reads (never a guest, merged, empty or other-Market cart, nor
// one a paid order left untouched; the next change clears the order mark), paged in
// `(last_changed_at, id)` order; and the record of reminders taken (once per account, cart change
// and stage; purged by age). The clock sits in 2030 so no other file's carts fall in the window, and no other file's purge
// reaches these.

const NOW = Temporal.Instant.from('2030-06-01T12:00:00Z');
const HOUR = 60 * 60 * 1000;

describe.each(TEST_MARKETS)('cart reminders in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const tokens = new CryptoGuestTokens();
  const ids = new UuidV7IdGenerator(new FixedClock(Temporal.Instant.from('2026-10-19T22:00:00Z')));
  let db: Persistence;
  let carts: PrismaCartRepository;
  let reminders: PrismaCartReminderRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    carts = new PrismaCartRepository(db.service);
    reminders = new PrismaCartReminderRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });
  beforeEach(async () => {
    await sql.query(`DELETE FROM cart.carts WHERE last_changed_at > '2030-01-01'`);
    await sql.query(`DELETE FROM notifications.cart_reminders WHERE taken_at > '2030-01-01'`);
  });

  const unit = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const cartAged = (
    target: MarketContext,
    ageHours: number,
    owner: 'account' | 'guest' | 'merged' = 'account',
    lines = 1,
  ): CartState => {
    const changed = NOW.subtract({ milliseconds: Math.round(ageHours * HOUR) });
    return {
      id: ids.next<'Cart'>(),
      marketId: target.marketId,
      owner:
        owner === 'account'
          ? { kind: 'account', accountId: ids.next<'Account'>() }
          : { kind: 'guest', tokenHash: tokens.issue().hash },
      status: owner === 'merged' ? 'merged' : 'active',
      lastChangedAt: changed,
      mergedIntoCartId: owner === 'merged' ? ids.next<'Cart'>() : null,
      mergedAt: owner === 'merged' ? changed : null,
      version: 1,
      createdAt: changed.subtract({ hours: 1 }),
      lines: Array.from({ length: lines }, () => ({
        id: ids.next<'CartLine'>(),
        offerId: ids.next<'Offer'>(),
        variantId: ids.next<'Variant'>(),
        quantity: 1,
        priceAtAdd: money(1000n, currency),
        addedAt: changed,
      })),
    };
  };
  const idle = (
    target: MarketContext,
    after: Parameters<typeof carts.idleAccountCarts>[1]['after'] = null,
    limit = 50,
  ) =>
    unit(target, () =>
      carts.idleAccountCarts(target, {
        changedAfter: NOW.subtract({ hours: 12 }),
        changedAtOrBefore: NOW.subtract({ hours: 4 }),
        after,
        limit,
      }),
    );

  it('lists only idle account carts with lines in the window, of this Market', async () => {
    const due = cartAged(market, 5, 'account', 2);
    const fresh = cartAged(market, 3);
    const stale = cartAged(market, 13);
    const guest = cartAged(market, 5, 'guest');
    const merged = cartAged(market, 5, 'merged');
    const empty = cartAged(market, 5, 'account', 0);
    const theirs = cartAged(other, 5);
    for (const cart of [due, fresh, stale, guest, merged, empty]) {
      expect(await unit(market, () => carts.insert(market, cart))).toBe('inserted');
    }
    await unit(other, () => carts.insert(other, theirs));

    expect(await idle(market)).toEqual([
      {
        cartId: due.id,
        accountId: due.owner.kind === 'account' ? due.owner.accountId : null,
        lastChangedAt: due.lastChangedAt,
        lineCount: 2,
      },
    ]);
  });

  it('leaves out a cart a paid order left untouched, until the buyer changes it again', async () => {
    const cart = cartAged(market, 6, 'account', 2);
    await unit(market, () => carts.insert(market, cart));
    const orderedAt = NOW.subtract({ hours: 5 });
    const afterOrder = { ...cart, lines: cart.lines.slice(1), lastChangedAt: orderedAt };
    await unit(market, async () => {
      expect(await carts.save(market, afterOrder)).toBe('saved');
      await carts.markOrdered(market, cart.id, orderedAt);
    });
    expect(await idle(market)).toEqual([]);

    // A mark for an instant other than the last change (a cart changed since) is not written.
    await unit(market, () => carts.markOrdered(market, cart.id, NOW.subtract({ hours: 6 })));
    const changedAt = NOW.subtract({ minutes: 270 });
    await unit(market, () =>
      carts.save(market, { ...afterOrder, version: 2, lastChangedAt: changedAt }),
    );
    expect((await idle(market)).map((c) => c.cartId)).toEqual([cart.id]);
  });

  it('pages in last-change order after the cursor, across equal instants, and narrows to accounts', async () => {
    const six = cartAged(market, 6);
    // Two carts changed at the same instant: the id orders them.
    const list = [
      cartAged(market, 7),
      six,
      { ...cartAged(market, 6), lastChangedAt: six.lastChangedAt },
    ];
    list.push(cartAged(market, 5));
    for (const cart of list) await unit(market, () => carts.insert(market, cart));
    const expected = [
      list[0]!,
      ...[list[1]!, list[2]!].sort((a, b) => (a.id < b.id ? -1 : 1)),
      list[3]!,
    ];
    const first = await idle(market, null, 2);
    expect(first.map((c) => c.cartId)).toEqual([expected[0]!.id, expected[1]!.id]);
    const last = first[first.length - 1]!;
    const second = await idle(
      market,
      { lastChangedAt: last.lastChangedAt, cartId: last.cartId },
      2,
    );
    expect(second.map((c) => c.cartId)).toEqual([expected[2]!.id, expected[3]!.id]);

    const only = list[3]!.owner.kind === 'account' ? list[3]!.owner.accountId : null;
    const narrowed = await unit(market, () =>
      carts.idleAccountCarts(market, {
        changedAfter: NOW.subtract({ hours: 12 }),
        changedAtOrBefore: NOW.subtract({ hours: 4 }),
        after: null,
        limit: 50,
        accountIds: [only!],
      }),
    );
    expect(narrowed.map((c) => c.cartId)).toEqual([list[3]!.id]);
  });

  it('takes a reminder stage once per cart change, per Market, and purges by age', async () => {
    const accountId = ids.next<'Account'>();
    const key = { accountId, cartChangedAt: NOW.subtract({ hours: 5 }), stage: 1 as const };
    expect(await unit(market, () => reminders.take(market, key, NOW))).toBe(true);
    expect(await unit(market, () => reminders.take(market, key, NOW))).toBe(false);
    expect(await unit(market, () => reminders.take(market, { ...key, stage: 2 }, NOW))).toBe(true);
    expect(
      await unit(market, () =>
        reminders.take(market, { ...key, cartChangedAt: NOW.subtract({ hours: 1 }) }, NOW),
      ),
    ).toBe(true);
    expect(await unit(other, () => reminders.take(other, key, NOW))).toBe(true);

    expect(await unit(market, () => reminders.purgeTakenBefore(market, NOW, 10))).toBe(0);
    const later = NOW.add({ seconds: 1 });
    expect(await unit(market, () => reminders.purgeTakenBefore(market, later, 2))).toBe(2);
    expect(await unit(market, () => reminders.purgeTakenBefore(market, later, 2))).toBe(1);
    const left = await sql.query(
      `SELECT market_id FROM notifications.cart_reminders WHERE account_id = $1`,
      [accountId],
    );
    expect(left.rows).toEqual([{ market_id: other.marketId }]);
  });

  it('refuses a stage other than 1 or 2 and an order mark after the last change', async () => {
    await expect(
      sql.query(
        `INSERT INTO notifications.cart_reminders
           (market_id, account_id, cart_changed_at, stage, tenant_id, taken_at)
         VALUES ($1, $2, now(), 3, 'default', now())`,
        [market.marketId, ids.next<'Account'>()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const cart = cartAged(market, 5);
    await unit(market, () => carts.insert(market, cart));
    await expect(
      sql.query(
        `UPDATE cart.carts SET ordered_at = last_changed_at + interval '1 second' WHERE id = $1`,
        [cart.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
