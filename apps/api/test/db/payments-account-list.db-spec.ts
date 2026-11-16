import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { ConnectedAccountRecord } from '../../src/modules/payments/application/ports/connected-account-store';
import type {
  AccountSnapshot,
  AccountStatus,
} from '../../src/modules/payments/domain/connected-account';
import {
  ACCOUNT_SORT_KEYS,
  type AccountListFilter,
} from '../../src/modules/payments/domain/connected-account-list';
import { PrismaConnectedAccountListReader } from '../../src/modules/payments/infrastructure/prisma-connected-account-list.reader';
import { PrismaConnectedAccountStore } from '../../src/modules/payments/infrastructure/prisma-connected-account-store';
import { MemoryAccountList } from '../support/payments-account-list-fakes';
import { MemoryAccountStore } from '../support/payments-fakes';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  randomUUID,
  type Persistence,
} from './persistence-support';

// The admin Seller accounts list (super list 22) on PostgreSQL, as the application role, for both
// Market fixtures: the filters, the status counts in one statement, the sorts with their tie, the
// older card's cursor, the reads by id, and that another Market's rows never show. Every seller
// is this file's own; each test narrows to its sellers.

const T0 = Temporal.Instant.from('2026-11-05T00:00:00Z');
const NOW = T0.add({ hours: 100 });
let sequence = 0;
const nextRef = () => `acct_list_${process.pid}_${(sequence += 1)}_${Date.now()}`;

describe.each(TEST_MARKETS)('the Seller accounts list in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let store: PrismaConnectedAccountStore;
  let reader: PrismaConnectedAccountListReader;

  beforeAll(() => {
    db = createPersistence();
    store = new PrismaConnectedAccountStore(db.service);
    reader = new PrismaConnectedAccountListReader(db.service);
  });
  afterAll(async () => {
    await db.close();
  });

  const write = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const read = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
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
    payoutScheduleInterval: 'daily',
    externalAccountCount: 1,
    defaultExternalAccountId: null,
    ...fields,
  });

  /** An account created at `at`, read once as `status` (unless not-started), with a waiting period. */
  async function account(fields: {
    readonly at: Temporal.Instant;
    readonly status?: AccountStatus;
    readonly due?: number;
    readonly pastDue?: boolean;
    readonly readAt?: Temporal.Instant;
    readonly until?: Temporal.Instant;
    readonly target?: MarketContext;
  }): Promise<string> {
    const target = fields.target ?? market;
    const sellerId = randomUUID();
    const ref = nextRef();
    await write(target, () => store.insert(target, sellerId, fields.at));
    await write(target, () => store.linkRef(target, sellerId, ref, fields.at));
    if ((fields.status ?? 'not-started') !== 'not-started') {
      await write(target, () =>
        store.applyRead(
          target,
          sellerId,
          snapshot(ref, {
            requirementsDue: fields.due ?? 0,
            requirementsPastDue: fields.pastDue ?? false,
          }),
          fields.status!,
          fields.readAt ?? fields.at,
        ),
      );
    }
    if (fields.until !== undefined) {
      const until = fields.until;
      const change = {
        id: randomUUID(),
        kind: 'updated' as const,
        detectedAt: fields.at,
        coolingOffUntil: until,
        sourceEventId: `evt_list_${process.pid}_${(sequence += 1)}_${Date.now()}`,
        detectedBy: 'webhook' as const,
      };
      expect(
        await write(target, () =>
          store.recordChange(target, sellerId, change, null, until, fields.at),
        ),
      ).toBe('recorded');
    }
    return sellerId;
  }

  const filterOf = (
    sellerIds: readonly string[],
    fields: Partial<AccountListFilter> = {},
  ): AccountListFilter => ({
    status: null,
    ready: null,
    requirements: null,
    waiting: null,
    sellerId: null,
    sellerIds,
    from: null,
    to: null,
    now: NOW,
    ...fields,
  });

  it('filters and counts the accounts of the Market, judging readiness at `now`', async () => {
    const ready = await account({ at: T0, status: 'enabled' });
    const waiting = await account({
      at: T0.add({ minutes: 1 }),
      status: 'enabled',
      until: NOW.add({ hours: 1 }),
    });
    const waited = await account({
      at: T0.add({ minutes: 2 }),
      status: 'enabled',
      until: NOW.subtract({ hours: 1 }),
    });
    const late = await account({
      at: T0.add({ minutes: 3 }),
      status: 'pending',
      due: 2,
      pastDue: true,
    });
    const fresh = await account({ at: T0.add({ minutes: 4 }) });
    const elsewhere = await account({ at: T0, status: 'enabled', target: other });
    const mine = [ready, waiting, waited, late, fresh, elsewhere];
    const newest = { key: 'created', direction: 'desc' } as const;
    const ids = async (fields: Partial<AccountListFilter>) =>
      (await read(market, () => reader.page(market, filterOf(mine, fields), newest, 0, 20))).map(
        (row) => row.sellerId,
      );
    expect(await ids({})).toEqual([fresh, late, waited, waiting, ready]);
    expect(await ids({ status: 'enabled' })).toEqual([waited, waiting, ready]);
    expect(await ids({ ready: true })).toEqual([waited, ready]);
    expect(await ids({ ready: false })).toEqual([fresh, late, waiting]);
    expect(await ids({ requirements: 'past-due' })).toEqual([late]);
    expect(await ids({ requirements: 'due' })).toEqual([late]);
    expect(await ids({ requirements: 'none' })).toEqual([fresh, waited, waiting, ready]);
    expect(await ids({ waiting: 'cooling-off' })).toEqual([waiting]);
    expect(await ids({ waiting: 'paused' })).toEqual([waiting]);
    expect(await ids({ sellerIds: null, sellerId: late })).toEqual([late]);
    expect(await ids({ from: T0.add({ minutes: 3 }), to: T0.add({ minutes: 4 }) })).toEqual([late]);
    expect(await read(market, () => reader.count(market, filterOf(mine)))).toBe(5);
    expect(
      await read(market, () => reader.countByStatus(market, filterOf(mine, { status: 'pending' }))),
    ).toEqual({ 'not-started': 1, pending: 1, enabled: 3, restricted: 0, rejected: 0 });
    expect(
      (await read(market, () => reader.byIds(market, [late, elsewhere]))).map((r) => r.sellerId),
    ).toEqual([late]);
    expect(await read(other, () => reader.byIds(other, [late]))).toEqual([]);
  });

  it("walks the older card's cursor newest created first across a tie", async () => {
    const older = await account({ at: T0.add({ hours: 5 }) });
    const tied = [
      await account({ at: T0.add({ hours: 6 }) }),
      await account({ at: T0.add({ hours: 6 }) }),
    ].sort((x, y) => (x < y ? 1 : -1));
    const mine = filterOf([older, ...tied]);
    const newest = { key: 'created', direction: 'desc' } as const;
    const first = await read(market, () => reader.page(market, mine, newest, 0, 1));
    expect(first.map((r) => r.sellerId)).toEqual([tied[0]]);
    const rest = await read(market, () =>
      reader.page(market, mine, newest, 0, 5, {
        createdAt: first[0]!.createdAt,
        sellerId: first[0]!.sellerId,
      }),
    );
    expect(rest.map((r) => r.sellerId)).toEqual([tied[1], older]);
  });

  it('orders every sort as the in-memory fake does (the fake the flow tests trust)', async () => {
    const at = T0.add({ hours: 20 });
    const sellerIds = [
      await account({ at, status: 'enabled', readAt: at.add({ hours: 3 }) }),
      await account({ at, status: 'pending', due: 1, readAt: at.add({ hours: 1 }) }),
      await account({ at: at.add({ minutes: 1 }), status: 'pending', due: 3, pastDue: true }),
      await account({ at: at.add({ minutes: 2 }) }),
      await account({ at: at.add({ minutes: 2 }), status: 'restricted', due: 1 }),
    ];
    const records: readonly ConnectedAccountRecord[] = await read(market, () =>
      reader.byIds(market, sellerIds),
    );
    const memory = new MemoryAccountStore();
    for (const row of records) {
      memory.rows.set(`${market.marketId}/${row.sellerId}`, { ...row, market: market.marketId });
    }
    const fake = new MemoryAccountList(memory);
    for (const direction of ['asc', 'desc'] as const) {
      for (const key of ACCOUNT_SORT_KEYS) {
        const sort = { key, direction };
        const real = await read(market, () => reader.ids(market, filterOf(sellerIds), sort, 10));
        expect([key, direction, real]).toEqual([
          key,
          direction,
          await fake.ids(market, filterOf(sellerIds), sort, 10),
        ]);
      }
    }
  });
});
