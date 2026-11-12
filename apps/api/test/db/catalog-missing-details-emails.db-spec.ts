import { err, ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { MissingDetailsEmail } from '../../src/modules/catalog/domain/missing-details-email';
import { Product } from '../../src/modules/catalog/domain/product';
import { simpleProductType } from '../../src/modules/catalog/domain/product-types/simple';
import { PrismaMissingDetailsEmailStore } from '../../src/modules/catalog/infrastructure/prisma-missing-details-email.store';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The "Email sellers" emails of the Missing details report on PostgreSQL (attributes A4-4), for
// both Market fixtures, as the API role: an email and its products are stored together; one
// pending email per seller (`email.pending`); "recent" is pending or sent and requested after the
// given instant; "last emailed" is the latest sent one; the job's due list and a notice move only
// out of pending at its version; the Market boundary; and the backstops that hold without the use
// case: the text never changes, a settled email never moves, nothing is deleted, and the API role
// may update only the notice columns. Times are the real clock's (the guard allows requested_at
// only within five minutes of the statement).

let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));
const now = () => Temporal.Now.instant().round({ smallestUnit: 'millisecond' });

describe.each(TEST_MARKETS)('catalog missing details emails in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const admin = uuid7() as Id<'Account'>;
  let db: Persistence;
  let owner: Client;
  let products: PrismaProductRepository;
  let store: PrismaMissingDetailsEmailStore;

  beforeAll(async () => {
    db = createPersistence();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
    products = new PrismaProductRepository(db.service);
    store = new PrismaMissingDetailsEmailStore(db.service);
  });
  afterAll(async () => {
    await owner.end();
    await db.close();
  });

  const write = async <T>(target: MarketContext, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const read = async <T>(target: MarketContext, work: () => Promise<T>) => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const sqlState = async (work: Promise<unknown>) => {
    try {
      await work;
      return 'none';
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  };

  async function aProduct(target: MarketContext, sellerId: string): Promise<Id<'Product'>> {
    const created = Product.create({
      id: uuid7() as Id<'Product'>,
      marketId: target.marketId,
      scope: 'SELLER',
      sellerId: sellerId as Id<'Seller'>,
      handler: simpleProductType,
      familyCode: 'default',
      productCode: `M${uuid7().replaceAll('-', '').slice(-12).toUpperCase()}`,
      variantId: uuid7() as Id<'Variant'>,
      now: now(),
    });
    if (!created.ok) throw new Error(created.error.code);
    await write(target, () => products.add(target, created.value));
    return created.value.state.id;
  }

  const anEmail = (
    target: MarketContext,
    sellerId: string,
    productIds: readonly Id<'Product'>[],
  ): MissingDetailsEmail =>
    MissingDetailsEmail.queue({
      id: uuid7() as Id<'MissingDetailsEmail'>,
      marketId: target.marketId,
      sellerId: sellerId as Id<'Seller'>,
      productIds,
      requestedByAccountId: admin,
      subject: `${productIds.length} of your products need more details`,
      text: 'Hi Shop,\n\n- Tea: Country of origin',
      now: now(),
    });

  /** Adds in its own unit; a refusal ends the unit with nothing written, as the use case does. */
  const add = async (target: MarketContext, email: MissingDetailsEmail) => {
    const result = await db.unitOfWork.run(target, async () => {
      const refused = await store.add(target, email);
      return refused === null ? ok(null) : err(refused);
    });
    return result.ok ? null : result.error;
  };

  it('stores an email with its products, one pending per seller, and reads it back as due', async () => {
    const seller = uuid7();
    const a = await aProduct(market, seller);
    const b = await aProduct(market, seller);
    const first = anEmail(market, seller, [a, b]);
    expect(await add(market, first)).toBeNull();
    expect(await add(market, anEmail(market, seller, [a]))).toBe('email.pending');
    // Another seller is not held back.
    const otherSeller = uuid7();
    const c = await aProduct(market, otherSeller);
    expect(await add(market, anEmail(market, otherSeller, [c]))).toBeNull();

    expect(await read(market, () => store.pendingSellers(market, [seller, uuid7()]))).toEqual(
      new Set([seller]),
    );
    const due = await read(market, () => store.dueNotices(market, now().add({ seconds: 1 }), 500));
    const mine = due.find((e) => e.state.id === first.state.id);
    expect(mine?.state).toEqual({ ...first.state, productIds: [a, b].sort() });
    const recent = await read(market, () =>
      store.recent(market, [a, c], now().subtract({ hours: 1 })),
    );
    expect(recent.map((r) => [r.sellerId, r.productId]).sort()).toEqual(
      [
        [seller, a],
        [otherSeller, c],
      ].sort(),
    );
    expect(await read(market, () => store.recent(market, [a], now().add({ hours: 1 })))).toEqual(
      [],
    );
    // The other Market sees none of it.
    expect(await read(other, () => store.pendingSellers(other, [seller]))).toEqual(new Set());
    expect(await read(other, () => store.recent(other, [a], now().subtract({ hours: 1 })))).toEqual(
      [],
    );
  });

  it('moves a notice only out of pending at its version; a sent one gives "last emailed"', async () => {
    const seller = uuid7();
    const a = await aProduct(market, seller);
    const email = anEmail(market, seller, [a]);
    await add(market, email);
    const deferred = email.failedAt(now())!;
    await write(market, () => store.saveNotice(market, deferred));
    // The same move again is stale.
    await expect(write(market, () => store.saveNotice(market, deferred))).rejects.toBeInstanceOf(
      StaleAggregateError,
    );
    expect(await read(market, () => store.lastEmailed(market, [a]))).toEqual(new Map());
    const sentAt = now();
    const sent = deferred.sent(sentAt)!;
    await write(market, () => store.saveNotice(market, sent));
    expect(await read(market, () => store.lastEmailed(market, [a]))).toEqual(
      new Map([[a, sentAt]]),
    );
    expect(await read(market, () => store.pendingSellers(market, [seller]))).toEqual(new Set());
    const recent = await read(market, () =>
      store.recent(market, [a], now().subtract({ hours: 1 })),
    );
    expect(recent).toEqual([
      { sellerId: seller, productId: a, requestedAt: email.state.requestedAt, emailedAt: sentAt },
    ]);
    // A sent email never moves again, not even through the owner role.
    expect(
      await sqlState(
        owner.query(
          `UPDATE catalog.missing_details_emails SET notice_state = 'failed', sent_at = NULL,
             version = version + 1 WHERE market_id = $1 AND id = $2`,
          [market.marketId, email.state.id],
        ),
      ),
    ).toBe('23001');
    // A skipped one is not "recent": it throttles nothing.
    const b = await aProduct(market, seller);
    const skipped = anEmail(market, seller, [b]);
    await add(market, skipped);
    await write(market, () => store.saveNotice(market, skipped.skipped()!));
    expect(
      await read(market, () => store.recent(market, [b], now().subtract({ hours: 1 }))),
    ).toEqual([]);
  });

  it('keeps the text, the products and every row: the guard and the grants', async () => {
    const seller = uuid7();
    const a = await aProduct(market, seller);
    const email = anEmail(market, seller, [a]);
    await add(market, email);
    const update = (sql: string) => sqlState(owner.query(sql, [market.marketId, email.state.id]));
    expect(
      await update(
        `UPDATE catalog.missing_details_emails SET subject = 'x', version = version + 1
          WHERE market_id = $1 AND id = $2`,
      ),
    ).toBe('23001');
    expect(
      await update(`DELETE FROM catalog.missing_details_emails WHERE market_id = $1 AND id = $2`),
    ).toBe('23001');
    expect(
      await update(
        `DELETE FROM catalog.missing_details_email_products WHERE market_id = $1 AND email_id = $2`,
      ),
    ).toBe('23001');
    // A new email is born pending.
    expect(
      await sqlState(
        owner.query(
          `INSERT INTO catalog.missing_details_emails (id, market_id, tenant_id, seller_id,
             requested_by_account_id, requested_at, subject, body, notice_state, notice_attempts,
             notice_next_attempt_at, sent_at, version)
           VALUES ($1, $2, $3, $4, $5, now(), 's', 'b', 'sent', 0, NULL, now(), 1)`,
          [uuid7(), market.marketId, market.tenantId, uuid7(), admin],
        ),
      ),
    ).toBe('23514');
    // The API role may not change the text (column grants): insufficient_privilege.
    const api = new Client({ connectionString: testDatabaseUrl() });
    await api.connect();
    try {
      expect(
        await sqlState(
          api.query(
            `UPDATE catalog.missing_details_emails SET subject = 'changed', version = version + 1
              WHERE market_id = $1 AND id = $2`,
            [market.marketId, email.state.id],
          ),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          api.query(
            `DELETE FROM catalog.missing_details_email_products WHERE market_id = $1 AND email_id = $2`,
            [market.marketId, email.state.id],
          ),
        ),
      ).toBe('42501');
    } finally {
      await api.end();
    }
  });
});
