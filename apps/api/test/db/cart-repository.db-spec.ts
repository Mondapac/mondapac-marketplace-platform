import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { CryptoGuestTokens } from '../../src/modules/cart/infrastructure/crypto-guest-tokens';
import { PrismaCartRepository } from '../../src/modules/cart/infrastructure/prisma-cart.repository';
import { mergeCarts, type CartState } from '../../src/modules/cart/domain/cart';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The cart store on PostgreSQL (cart.carts, cart.cart_lines), as the application role, for both
// Market fixtures: round trip with lines, optimistic version, the one-active-cart-per-account and
// one-cart-per-guest-hash rules, the Market guard, and the CHECKs the application would never
// violate but the database must still refuse.

const T0 = Temporal.Instant.from('2026-10-09T10:00:00Z');
const UNIQUE = '23505';
const CHECK = '23514';

describe.each(TEST_MARKETS)('cart repository in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const tokens = new CryptoGuestTokens();
  let db: Persistence;
  let repository: PrismaCartRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    repository = new PrismaCartRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const inUnit = <T>(target: MarketContext, work: () => Promise<T>) =>
    db.unitOfWork.run(target, async () => ok(await work()));
  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await inUnit(target, work);
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  const newCart = (owner: CartState['owner'], lines = 1): CartState => ({
    id: ids.next<'Cart'>(),
    marketId: market.marketId,
    owner,
    status: 'active',
    lastChangedAt: T0,
    mergedIntoCartId: null,
    mergedAt: null,
    version: 1,
    createdAt: T0,
    lines: Array.from({ length: lines }, (_, n) => ({
      id: ids.next<'CartLine'>(),
      offerId: ids.next<'Offer'>(),
      variantId: ids.next<'Variant'>(),
      quantity: n + 1,
      priceAtAdd: money(1999n, currency),
      addedAt: T0.add({ seconds: n }),
    })),
  });
  const guestOwner = (): { cart: CartState['owner']; token: string } => {
    const { token, hash } = tokens.issue();
    return { cart: { kind: 'guest', tokenHash: hash }, token };
  };

  it('stores a guest cart with its lines and finds it by the token hash, never by the token', async () => {
    const { cart: owner, token } = guestOwner();
    const cart = newCart(owner, 2);

    expect(await value(market, () => repository.insert(market, cart))).toBe('inserted');
    const found = await value(market, () =>
      repository.findByGuestHash(market, tokens.hashOf(token)!),
    );

    expect(found).toEqual(cart);
    const raw = await sql.query<{ guest_token_hash: Buffer }>(
      'SELECT guest_token_hash FROM cart.carts WHERE id = $1',
      [cart.id],
    );
    expect(Buffer.from(raw.rows[0]!.guest_token_hash).toString('hex')).toBe(
      (owner as { tokenHash: string }).tokenHash,
    );
    expect(Buffer.from(raw.rows[0]!.guest_token_hash).toString('utf8')).not.toContain(token);
  });

  it('refuses a second active cart for an account and a second cart for a guest hash', async () => {
    const account = ids.next<'Account'>();
    const first = newCart({ kind: 'account', accountId: account });
    const { cart: owner } = guestOwner();
    const guest = newCart(owner);
    await value(market, () => repository.insert(market, first));
    await value(market, () => repository.insert(market, guest));

    expect(
      await value(market, () =>
        repository.insert(market, newCart({ kind: 'account', accountId: account })),
      ),
    ).toBe('duplicate');
    expect(await value(market, () => repository.insert(market, newCart(owner)))).toBe('duplicate');
    expect((await value(market, () => repository.findActiveByAccount(market, account)))?.id).toBe(
      first.id,
    );
  });

  it('saves under the version it read and refuses a stale write', async () => {
    const account = ids.next<'Account'>();
    const cart = newCart({ kind: 'account', accountId: account }, 2);
    await value(market, () => repository.insert(market, cart));
    const [keep, drop] = cart.lines as [CartState['lines'][number], CartState['lines'][number]];
    const added = {
      ...keep,
      id: ids.next<'CartLine'>(),
      offerId: ids.next<'Offer'>(),
      quantity: 7,
      addedAt: T0.add({ minutes: 5 }),
    };
    const edited: CartState = {
      ...cart,
      lastChangedAt: T0.add({ minutes: 5 }),
      lines: [{ ...keep, quantity: 9, priceAtAdd: money(2500n, currency) }, added],
    };

    expect(await value(market, () => repository.save(market, edited))).toBe('saved');
    expect(await value(market, () => repository.save(market, edited))).toBe('stale');

    const read = await value(market, () => repository.findActiveByAccount(market, account));
    expect(read?.version).toBe(2);
    expect(read?.lines.map((l) => [l.id, l.quantity])).toEqual(
      [...edited.lines].map((l) => [l.id, l.quantity]),
    );
    expect(read?.lines.find((l) => l.id === keep.id)?.priceAtAdd).toEqual(money(2500n, currency));
    expect(read?.lines.some((l) => l.id === drop.id)).toBe(false);
  });

  it('moves a guest cart to an account and keeps a merged guest cart recognisable', async () => {
    const { cart: owner, token } = guestOwner();
    const guest = newCart(owner);
    const account = ids.next<'Account'>();
    await value(market, () => repository.insert(market, guest));

    await value(market, () =>
      repository.save(market, { ...guest, owner: { kind: 'account', accountId: account } }),
    );
    expect(
      await value(market, () => repository.findByGuestHash(market, tokens.hashOf(token)!)),
    ).toBeNull();
    expect((await value(market, () => repository.findActiveByAccount(market, account)))?.id).toBe(
      guest.id,
    );

    const { cart: owner2, token: token2 } = guestOwner();
    const second = newCart(owner2);
    await value(market, () => repository.insert(market, second));
    await value(market, () =>
      repository.save(market, {
        ...second,
        status: 'merged',
        lines: [],
        mergedIntoCartId: guest.id,
        mergedAt: T0.add({ minutes: 1 }),
      }),
    );
    const replay = await value(market, () =>
      repository.findByGuestHash(market, tokens.hashOf(token2)!),
    );
    expect(replay).toMatchObject({ status: 'merged', lines: [], mergedIntoCartId: guest.id });
  });

  it('merges a guest cart with a line the account cart lacks: the guest saves first, the line id moves', async () => {
    const account = ids.next<'Account'>();
    const mine = newCart({ kind: 'account', accountId: account }, 1);
    const { cart: owner, token } = guestOwner();
    const guest = newCart(owner, 2);
    await value(market, () => repository.insert(market, mine));
    await value(market, () => repository.insert(market, guest));
    const merged = mergeCarts(
      mine,
      guest,
      { maxLineQuantity: 99, maxLines: 50 },
      () => null,
      T0.add({ minutes: 1 }),
    );

    const saved = await value(market, async () => [
      await repository.save(market, merged.guest),
      await repository.save(market, merged.account),
    ]);

    expect(saved).toEqual(['saved', 'saved']);
    const read = await value(market, () => repository.findActiveByAccount(market, account));
    expect(read?.lines).toHaveLength(3);
    expect(new Set(read?.lines.map((l) => l.id))).toEqual(
      new Set([...mine.lines, ...guest.lines].map((l) => l.id)),
    );
    const replay = await value(market, () =>
      repository.findByGuestHash(market, tokens.hashOf(token)!),
    );
    expect(replay).toMatchObject({ status: 'merged', lines: [] });
  });

  it('never shows a cart to another Market', async () => {
    const account = ids.next<'Account'>();
    const { cart: owner, token } = guestOwner();
    await value(market, () =>
      repository.insert(market, newCart({ kind: 'account', accountId: account })),
    );
    await value(market, () => repository.insert(market, newCart(owner)));

    expect(await value(other, () => repository.findActiveByAccount(other, account))).toBeNull();
    expect(
      await value(other, () => repository.findByGuestHash(other, tokens.hashOf(token)!)),
    ).toBeNull();
  });

  describe('constraints', () => {
    const state = async (text: string, values: unknown[]): Promise<string | null> => {
      try {
        await sql.query(text, values);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
      }
    };
    const insertCart = (row: Record<string, unknown>) => {
      const base = {
        id: ids.next(),
        market_id: code,
        tenant_id: market.tenantId,
        status: 'active',
        last_changed_at: T0.toString(),
        version: 1,
        created_at: T0.toString(),
        ...row,
      };
      const columns = Object.keys(base);
      return state(
        `INSERT INTO cart.carts (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(base),
      );
    };

    it('refuses a cart with no owner, with two owners and with a short token hash', async () => {
      expect(await insertCart({})).toBe(CHECK);
      expect(
        await insertCart({ account_id: ids.next(), guest_token_hash: Buffer.alloc(32, 1) }),
      ).toBe(CHECK);
      expect(await insertCart({ guest_token_hash: Buffer.alloc(16, 1) })).toBe(CHECK);
    });

    it('refuses a guest hash used twice and a line quantity of 0', async () => {
      const hash = Buffer.alloc(32, 7);
      hash.writeUInt32BE(Math.floor(Math.random() * 2 ** 32), 0);
      expect(await insertCart({ guest_token_hash: hash })).toBeNull();
      expect(await insertCart({ guest_token_hash: hash })).toBe(UNIQUE);

      const cart = newCart({ kind: 'account', accountId: ids.next<'Account'>() });
      await value(market, () => repository.insert(market, cart));
      expect(
        await state(
          `INSERT INTO cart.cart_lines (id, market_id, tenant_id, cart_id, offer_id, variant_id, quantity,
             price_at_add_amount, price_at_add_currency, added_at)
           VALUES ($1, $2, $3, $4, $5, $6, 0, 1, $7, $8)`,
          [
            ids.next(),
            code,
            market.tenantId,
            cart.id,
            ids.next(),
            ids.next(),
            currency,
            T0.toString(),
          ],
        ),
      ).toBe(CHECK);
    });
  });
});
