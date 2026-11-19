import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { PrismaCustomerListReader } from '../../src/modules/customers/infrastructure/prisma-customer-list.reader';
import { PrismaCustomerReadModelRepository } from '../../src/modules/customers/infrastructure/prisma-customer-read-models.repository';
import { PrismaSavedFilterRepository } from '../../src/modules/customers/infrastructure/prisma-saved-filter.repository';
import type { CustomerSelector } from '../../src/modules/customers/domain/customer-list';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The admin Customers list as the application role, in both Market fixtures: the directory and
// stats rows are read in one query through the relation, every tab, filter and sort answers what
// the application means, a customer with no stats row counts as zero orders, the Markets stay
// apart, a stats row goes with its directory row, and the saved-filter table enforces its name
// uniques and its column grants.

const T0 = Temporal.Instant.from('2026-11-15T12:00:00Z');
const ids = new UuidV7IdGenerator(new FixedClock(T0));
const day = (n: number): Temporal.Instant => T0.subtract({ hours: 24 * n });
const BLANK: CustomerSelector = {
  view: 'all',
  text: null,
  status: null,
  verified: null,
  joinedFrom: null,
  joinedTo: null,
  lastOrderFrom: null,
  lastOrderTo: null,
  ordersMin: null,
  ordersMax: null,
  spentMin: null,
  spentMax: null,
  group: null,
};

describe.each(TEST_MARKETS)('admin customers list in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let models: PrismaCustomerReadModelRepository;
  let reader: PrismaCustomerListReader;
  let filters: PrismaSavedFilterRepository;
  let sql: Client;
  // A prefix no other test uses, so the search finds only these rows.
  const tag = `lst${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    db = createPersistence();
    models = new PrismaCustomerReadModelRepository(db.service);
    reader = new PrismaCustomerListReader(db.service);
    filters = new PrismaSavedFilterRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const inUnit = async <T>(target: typeof market, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  const accounts = {
    amina: ids.next<'Account'>(),
    bilal: ids.next<'Account'>(),
    carim: ids.next<'Account'>(),
    dana: ids.next<'Account'>(),
  };

  beforeAll(async () => {
    const entry = (accountId: Id<'Account'>, name: string, over = {}) => ({
      accountId,
      email: `${tag}.${name}@example.test`,
      displayName: `${tag} ${name}`,
      status: 'active' as const,
      emailVerified: true,
      signedUpAt: day(200),
      ...over,
    });
    const stats = (accountId: Id<'Account'>, over = {}) => ({
      accountId,
      firstOrderAt: day(100),
      lastOrderAt: day(10),
      orderCount: 3,
      spentMinor: 30_000n,
      currency: 'AUD',
      refundCount: 0,
      refundedMinor: 0n,
      ...over,
    });
    await inUnit(market, async () => {
      await models.upsertDirectory(
        market,
        entry(accounts.amina, 'amina', { signedUpAt: day(5) }),
        T0,
      );
      await models.upsertDirectory(
        market,
        entry(accounts.bilal, 'bilal', { signedUpAt: day(150) }),
        T0,
      );
      await models.upsertStats(market, stats(accounts.bilal), T0);
      await models.upsertDirectory(
        market,
        entry(accounts.carim, 'carim', {
          signedUpAt: day(160),
          status: 'disabled',
          emailVerified: false,
        }),
        T0,
      );
      await models.upsertStats(
        market,
        stats(accounts.carim, {
          firstOrderAt: day(155),
          lastOrderAt: day(150),
          orderCount: 1,
          spentMinor: 5_000n,
        }),
        T0,
      );
      // A customer with a zero stats row (never ordered, but synced).
      await models.upsertDirectory(
        market,
        entry(accounts.dana, 'dana', { signedUpAt: day(300) }),
        T0,
      );
      await models.upsertStats(
        market,
        stats(accounts.dana, {
          firstOrderAt: null,
          lastOrderAt: null,
          orderCount: 0,
          spentMinor: 0n,
          currency: null,
        }),
        T0,
      );
    });
    await inUnit(other, () =>
      models.upsertDirectory(
        other,
        {
          accountId: ids.next<'Account'>(),
          email: `${tag}.elsewhere@example.test`,
          displayName: null,
          status: 'active',
          emailVerified: true,
          signedUpAt: day(1),
        },
        T0,
      ),
    );
  });

  const query = (over: Partial<CustomerSelector>, zone = 'UTC') => ({
    selector: { ...BLANK, text: tag, ...over },
    now: T0,
    zone,
  });
  const emails = async (
    over: Partial<CustomerSelector>,
    sort: 'joined' | 'orders' | 'spent' | 'last-order' | 'name' | 'email' = 'joined',
    direction: 'asc' | 'desc' = 'desc',
  ) =>
    (
      await inUnit(market, () =>
        reader.rows(market, query(over), { sort, direction }, { offset: 0, limit: 50 }),
      )
    ).map((row) => row.email.replace(`${tag}.`, '').replace('@example.test', ''));

  it('reads the directory and stats rows in one query and never shows another Market', async () => {
    const rows = await inUnit(market, () =>
      reader.rows(
        market,
        query({}),
        { sort: 'joined', direction: 'desc' },
        { offset: 0, limit: 50 },
      ),
    );
    expect(rows.map((row) => row.accountId)).toEqual([
      accounts.amina,
      accounts.bilal,
      accounts.carim,
      accounts.dana,
    ]);
    const bilal = rows.find((row) => row.accountId === accounts.bilal)!;
    expect(bilal).toMatchObject({ orderCount: 3, spentMinor: 30_000n, currency: 'AUD' });
    expect(bilal.lastOrderAt?.epochMilliseconds).toBe(day(10).epochMilliseconds);
    // Amina has no stats row at all: zero orders, nothing spent.
    expect(rows[0]).toMatchObject({ orderCount: 0, spentMinor: 0n, lastOrderAt: null });
    expect(await inUnit(market, () => reader.count(market, query({})))).toBe(4);
  });

  it('answers each tab', async () => {
    expect(await emails({ view: 'new' })).toEqual(['amina']);
    expect(await emails({ view: 'active' })).toEqual(['bilal']);
    expect(await emails({ view: 'inactive' })).toEqual(['carim']);
    expect(await emails({ view: 'never-ordered' })).toEqual(['amina', 'dana']);
    expect(await emails({ view: 'disabled' })).toEqual(['carim']);
    const counts = await inUnit(market, () => reader.viewCounts(market, T0));
    expect(counts.all).toBeGreaterThanOrEqual(4);
    expect(counts['pending-deletion']).toBeGreaterThanOrEqual(0);
  });

  it('applies the filters, counting a missing stats row as zero', async () => {
    expect(await emails({ status: 'disabled' })).toEqual(['carim']);
    expect(await emails({ verified: false })).toEqual(['carim']);
    expect(await emails({ ordersMin: 2 })).toEqual(['bilal']);
    expect(await emails({ ordersMax: 0 })).toEqual(['amina', 'dana']);
    expect(await emails({ ordersMax: 1 })).toEqual(['amina', 'carim', 'dana']);
    expect(await emails({ spentMin: 10_000n })).toEqual(['bilal']);
    expect(await emails({ spentMax: 5_000n })).toEqual(['amina', 'carim', 'dana']);
    expect(
      await emails({
        joinedFrom: day(170).toString().slice(0, 10),
        joinedTo: day(140).toString().slice(0, 10),
      }),
    ).toEqual(['bilal', 'carim']);
    expect(
      await emails({
        lastOrderFrom: day(20).toString().slice(0, 10),
        lastOrderTo: day(5).toString().slice(0, 10),
      }),
    ).toEqual(['bilal']);
  });

  it('reads the day filters in the zone it is given (ADR-0005), not in UTC', async () => {
    // Amina signed up at 2026-11-10T12:00Z: the 10th in UTC, already the 11th at UTC+14.
    const rows = async (over: Partial<CustomerSelector>, zone: string) =>
      (
        await inUnit(market, () =>
          reader.rows(
            market,
            query(over, zone),
            { sort: 'joined', direction: 'desc' },
            {
              offset: 0,
              limit: 50,
            },
          ),
        )
      ).map((row) => row.accountId);
    const eleventh = { joinedFrom: '2026-11-11', joinedTo: '2026-11-11' };
    expect(await rows(eleventh, 'Pacific/Kiritimati')).toEqual([accounts.amina]);
    expect(await rows(eleventh, 'UTC')).toEqual([]);
    const tenth = { joinedFrom: '2026-11-10', joinedTo: '2026-11-10' };
    expect(await rows(tenth, 'UTC')).toEqual([accounts.amina]);
    expect(await rows(tenth, 'Pacific/Kiritimati')).toEqual([]);
  });

  it('searches an address prefix and part of a name, whatever the case', async () => {
    expect(
      await inUnit(market, () =>
        reader.count(market, {
          selector: { ...BLANK, text: tag.toUpperCase() },
          now: T0,
          zone: 'UTC',
        }),
      ),
    ).toBe(4);
    expect(
      await inUnit(market, () =>
        reader.count(market, {
          selector: { ...BLANK, text: `${tag} BILAL` },
          now: T0,
          zone: 'UTC',
        }),
      ),
    ).toBe(1);
  });

  it('matches a search wildcard as itself, never as a pattern', async () => {
    for (const text of ['%%', '%%%', '__', '___', '\\']) {
      expect(
        await inUnit(market, () =>
          reader.count(market, { selector: { ...BLANK, text }, now: T0, zone: 'UTC' }),
        ),
      ).toBe(0);
    }
  });

  it('sorts by orders and spent in both directions, a never-ordered customer last or first', async () => {
    // The sync writes a stats row for every customer, so the fixture row with none (amina) is left out.
    const known = async (sort: 'orders' | 'spent', direction: 'asc' | 'desc') =>
      (await emails({}, sort, direction)).filter((name) => name !== 'amina');
    for (const sort of ['orders', 'spent'] as const) {
      expect(await known(sort, 'desc')).toEqual(['bilal', 'carim', 'dana']);
      expect(await known(sort, 'asc')).toEqual(['dana', 'carim', 'bilal']);
    }
  });

  it('sorts by every column and pages without repeating a row', async () => {
    expect(await emails({}, 'joined', 'asc')).toEqual(['dana', 'carim', 'bilal', 'amina']);
    expect(await emails({}, 'email', 'asc')).toEqual(['amina', 'bilal', 'carim', 'dana']);
    expect(await emails({}, 'name', 'desc')).toEqual(['dana', 'carim', 'bilal', 'amina']);
    expect((await emails({}, 'last-order', 'desc')).slice(0, 2)).toEqual(
      expect.arrayContaining(['bilal', 'carim']),
    );
    const first = await inUnit(market, () =>
      reader.rows(
        market,
        query({}),
        { sort: 'joined', direction: 'desc' },
        { offset: 0, limit: 2 },
      ),
    );
    const second = await inUnit(market, () =>
      reader.rows(
        market,
        query({}),
        { sort: 'joined', direction: 'desc' },
        { offset: 2, limit: 2 },
      ),
    );
    expect([...first, ...second].map((row) => row.accountId)).toEqual([
      accounts.amina,
      accounts.bilal,
      accounts.carim,
      accounts.dana,
    ]);
  });

  it('answers the ids of a filter and the rows of known ids in the order given', async () => {
    const matching = await inUnit(market, () =>
      reader.ids(market, query({ view: 'never-ordered' }), 10),
    );
    expect(matching).toEqual([accounts.amina, accounts.dana]);
    const named = await inUnit(market, () =>
      reader.rowsByIds(market, [accounts.dana, ids.next<'Account'>(), accounts.amina]),
    );
    expect(named.map((row) => row.accountId)).toEqual([accounts.dana, accounts.amina]);
  });

  it('removes a stats row together with its directory row', async () => {
    const account = ids.next<'Account'>();
    await inUnit(market, async () => {
      await models.upsertDirectory(
        market,
        {
          accountId: account,
          email: `${tag}.gone@example.test`,
          displayName: null,
          status: 'active',
          emailVerified: true,
          signedUpAt: day(1),
        },
        T0,
      );
      await models.upsertStats(
        market,
        {
          accountId: account,
          firstOrderAt: day(1),
          lastOrderAt: day(1),
          orderCount: 1,
          spentMinor: 100n,
          currency: 'AUD',
          refundCount: 0,
          refundedMinor: 0n,
        },
        T0,
      );
    });
    await sql.query(
      'DELETE FROM customers.customer_directory WHERE market_id = $1 AND account_id = $2',
      [market.marketId, account],
    );
    const left = await sql.query(
      'SELECT 1 FROM customers.customer_stats WHERE market_id = $1 AND account_id = $2',
      [market.marketId, account],
    );
    expect(left.rowCount).toBe(0);
  });

  describe('saved filters', () => {
    const owner = ids.next<'Account'>();
    const filter = (name: string, visibility: 'me' | 'everyone', over = {}) => ({
      id: ids.next<'SavedFilter'>(),
      listKey: 'admin.customers.customers',
      ownerAccountId: owner,
      visibility,
      name,
      payload: { v: 1, view: 'all' },
      position: 1,
      createdAt: T0,
      updatedAt: T0,
      ...over,
    });

    it('refuses a repeated name per owner and among shared filters, whatever the case', async () => {
      const name = `${tag} weekly`;
      expect(await inUnit(market, () => filters.add(market, filter(name, 'me')))).toBe('ok');
      expect(
        await inUnit(market, () => filters.add(market, filter(name.toUpperCase(), 'me'))),
      ).toBe('name-taken');
      expect(
        await inUnit(market, () => filters.add(market, filter(`${tag} shared`, 'everyone'))),
      ).toBe('ok');
      expect(
        await inUnit(market, () =>
          filters.add(
            market,
            filter(`${tag} SHARED`, 'everyone', { ownerAccountId: ids.next<'Account'>() }),
          ),
        ),
      ).toBe('name-taken');
    });

    it('keeps the Markets apart and lets the application rename but not rewrite a document', async () => {
      const mine = filter(`${tag} apart`, 'everyone');
      await inUnit(market, () => filters.add(market, mine));
      expect(await inUnit(other, () => filters.find(other, mine.id))).toBeNull();
      await inUnit(market, () =>
        filters.change(market, {
          ...mine,
          name: `${tag} renamed`,
          updatedAt: T0.add({ hours: 1 }),
        }),
      );
      expect((await inUnit(market, () => filters.find(market, mine.id)))?.name).toBe(
        `${tag} renamed`,
      );
      const app = new Client({ connectionString: testDatabaseUrl() });
      await app.connect();
      try {
        await expect(
          app.query(`UPDATE customers.saved_filters SET payload = '{}'::jsonb WHERE id = $1`, [
            mine.id,
          ]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await app.end();
      }
    });
  });
});
