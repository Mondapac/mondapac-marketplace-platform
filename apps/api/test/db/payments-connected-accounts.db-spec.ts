import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { PrismaConnectedAccountStore } from '../../src/modules/payments/infrastructure/prisma-connected-account-store';
import type { AccountSnapshot } from '../../src/modules/payments/domain/connected-account';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  randomUUID,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The connected accounts on PostgreSQL (payments.connected_accounts), as the application role, for
// both Market fixtures: one row per seller and Market, the Stripe id set once, an older read never
// replacing a newer one, the Market guard, and the CHECKs the application would never violate.

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const CHECK = '23514';
// Prisma reports a unique violation under its own code.
const UNIQUE = 'P2002';
const DENIED = '42501';
let sequence = 0;
const nextRef = () => `acct_test_${process.pid}_${(sequence += 1)}_${Date.now()}`;

describe.each(TEST_MARKETS)('connected accounts in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let store: PrismaConnectedAccountStore;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    store = new PrismaConnectedAccountStore(db.service);
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
  const snapshot = (id: string, fields: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
    id,
    metadataMarketId: code,
    metadataSellerId: null,
    detailsSubmitted: true,
    transfersActive: true,
    payoutsEnabled: true,
    requirementsDue: 0,
    requirementsPastDue: false,
    disabledReason: null,
    ...fields,
  });

  it('stores a seller once, links the Stripe id once, and keeps the newest read', async () => {
    const sellerId = randomUUID();
    const ref = nextRef();

    expect(await value(market, () => store.insert(market, sellerId, T0))).toBe(true);
    expect(await value(market, () => store.insert(market, sellerId, T0))).toBe(false);
    expect(await value(market, () => store.find(market, sellerId))).toMatchObject({
      sellerId,
      accountRef: null,
      status: 'not-started',
      lastReadAt: null,
    });
    // Another Market has no such seller, and cannot link or read it.
    expect(await value(other, () => store.find(other, sellerId))).toBeNull();
    expect(await value(other, () => store.linkRef(other, sellerId, ref, T0))).toBe(false);

    expect(await value(market, () => store.linkRef(market, sellerId, ref, T0))).toBe(true);
    expect(await value(market, () => store.linkRef(market, sellerId, nextRef(), T0))).toBe(false);
    expect(await value(market, () => store.findByRef(market, ref))).toMatchObject({ sellerId });
    expect(await value(other, () => store.findByRef(other, ref))).toBeNull();

    const at = T0.add({ seconds: 5 });
    expect(
      await value(market, () => store.applyRead(market, sellerId, snapshot(ref), 'enabled', at)),
    ).toBe(true);
    // The same or an older read changes nothing; so does a read of another account's id.
    expect(
      await value(market, () =>
        store.applyRead(
          market,
          sellerId,
          snapshot(ref, { payoutsEnabled: false }),
          'restricted',
          at,
        ),
      ),
    ).toBe(false);
    expect(
      await value(market, () =>
        store.applyRead(market, sellerId, snapshot(nextRef()), 'enabled', at.add({ seconds: 9 })),
      ),
    ).toBe(false);
    expect(await value(market, () => store.find(market, sellerId))).toMatchObject({
      status: 'enabled',
      payoutsEnabled: true,
      lastReadAt: at,
    });
    expect(
      await value(market, () =>
        store.applyRead(
          market,
          sellerId,
          snapshot(ref, { requirementsPastDue: true, requirementsDue: 3 }),
          'restricted',
          at.add({ seconds: 1 }),
        ),
      ),
    ).toBe(true);
    expect(await value(market, () => store.statusesOf(market, [sellerId, randomUUID()]))).toEqual(
      new Map([[sellerId, 'restricted']]),
    );
    expect(await value(other, () => store.statusesOf(other, [sellerId]))).toEqual(new Map());
  });

  it('refuses a second row for the same Stripe id, and values the application would never write', async () => {
    const ref = nextRef();
    const [first, second] = [randomUUID(), randomUUID()];
    await value(market, () => store.insert(market, first, T0));
    await value(market, () => store.insert(market, second, T0));
    await value(market, () => store.linkRef(market, first, ref, T0));
    await expect(value(market, () => store.linkRef(market, second, ref, T0))).rejects.toMatchObject(
      {
        code: UNIQUE,
      },
    );

    const insert = (change: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        market_id: code,
        seller_id: randomUUID(),
        tenant_id: market.tenantId,
        account_ref: null,
        status: 'not-started',
        details_submitted: false,
        transfers_active: false,
        payouts_enabled: false,
        requirements_due: 0,
        requirements_past_due: false,
        created_at: '2026-10-14T10:00:00Z',
        updated_at: '2026-10-14T10:00:00Z',
        ...change,
      };
      const columns = Object.keys(row);
      return sql.query(
        `INSERT INTO payments.connected_accounts (${columns.join(', ')}) VALUES (${columns
          .map((_c, i) => `$${i + 1}`)
          .join(', ')})`,
        Object.values(row),
      );
    };
    await expect(insert({ status: 'closed' })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ account_ref: 'cs_1', status: 'pending' })).rejects.toMatchObject({
      code: CHECK,
    });
    await expect(insert({ requirements_due: -1 })).rejects.toMatchObject({ code: CHECK });
    // An account that does not exist at Stripe yet cannot claim any state but not-started.
    await expect(insert({ status: 'enabled' })).rejects.toMatchObject({ code: CHECK });
    await expect(insert({ market_id: 'a' })).rejects.toMatchObject({ code: CHECK });
  });

  it('gives the application role no DELETE and no update of the identity columns', async () => {
    const sellerId = randomUUID();
    await value(market, () => store.insert(market, sellerId, T0));
    await expect(
      sql.query('DELETE FROM payments.connected_accounts WHERE seller_id = $1', [sellerId]),
    ).rejects.toMatchObject({ code: DENIED });
    await expect(
      sql.query("UPDATE payments.connected_accounts SET market_id = 'XX' WHERE seller_id = $1", [
        sellerId,
      ]),
    ).rejects.toMatchObject({ code: DENIED });
  });
});
