import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { CustomerSelector } from '../../src/modules/customers/domain/customer-list';
import type { CustomerGroup } from '../../src/modules/customers/domain/customer-groups';
import type { TimelineEntry } from '../../src/modules/customers/domain/customer-timeline';
import { PrismaCustomerGroupRepository } from '../../src/modules/customers/infrastructure/prisma-customer-groups.repository';
import { PrismaCustomerListReader } from '../../src/modules/customers/infrastructure/prisma-customer-list.reader';
import { PrismaCustomerNoteRepository } from '../../src/modules/customers/infrastructure/prisma-customer-notes.repository';
import { PrismaCustomerReadModelRepository } from '../../src/modules/customers/infrastructure/prisma-customer-read-models.repository';
import { PrismaCustomerTimelineRepository } from '../../src/modules/customers/infrastructure/prisma-customer-timeline.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Customers management phase 2 (PR 2a) as the application role, in both Market fixtures: manual
// groups (a name unique per Market whatever its case, the version guard, members only for
// directory rows of the same Market), the list's `group` filter and `groups` column, notes
// (keyset paging), the timeline (once per source event, the directory check, filters and order),
// the CHECK constraints, and the erasure that takes notes, timeline and memberships with it.

const T0 = Temporal.Instant.from('2026-11-15T12:00:00Z');
const ids = new UuidV7IdGenerator(new FixedClock(T0));
const at = (minutes: number) => T0.subtract({ minutes });
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
const SEALED = `v1.${'A'.repeat(48)}`;

describe.each(TEST_MARKETS)('customers management in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let models: PrismaCustomerReadModelRepository;
  let reader: PrismaCustomerListReader;
  let groups: PrismaCustomerGroupRepository;
  let notes: PrismaCustomerNoteRepository;
  let timeline: PrismaCustomerTimelineRepository;
  let sql: Client;
  const tag = `mgt${Math.random().toString(36).slice(2, 8)}`;
  const admin = ids.next<'Account'>();

  beforeAll(async () => {
    db = createPersistence();
    models = new PrismaCustomerReadModelRepository(db.service);
    reader = new PrismaCustomerListReader(db.service);
    groups = new PrismaCustomerGroupRepository(db.service);
    notes = new PrismaCustomerNoteRepository(db.service);
    timeline = new PrismaCustomerTimelineRepository(db.service);
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

  const customer = async (target = market): Promise<Id<'Account'>> => {
    const accountId = ids.next<'Account'>();
    await inUnit(target, () =>
      models.upsertDirectory(
        target,
        {
          accountId,
          email: `${tag}.${accountId.slice(-6)}@example.test`,
          displayName: `${tag} customer`,
          status: 'active',
          emailVerified: true,
          signedUpAt: at(60 * 24),
        },
        T0,
      ),
    );
    return accountId;
  };

  const group = (name: string, over: Partial<CustomerGroup> = {}): CustomerGroup => ({
    id: ids.next<'CustomerGroup'>(),
    name,
    description: null,
    kind: 'manual',
    archivedAt: null,
    createdByAccountId: admin,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
    ...over,
  });

  const entry = (accountId: Id<'Account'>, over: Partial<TimelineEntry> = {}): TimelineEntry => ({
    id: ids.next<'CustomerTimelineEntry'>(),
    accountId,
    occurredAt: T0,
    kind: 'signed-up',
    ref: null,
    actorAccountId: null,
    detail: null,
    sourceEventId: ids.next(),
    ...over,
  });

  describe('groups', () => {
    it('keeps a name unique per Market whatever its case, and another Market may reuse it', async () => {
      expect(await inUnit(market, () => groups.insert(market, group(`${tag} VIP`)))).toBe('ok');
      expect(await inUnit(market, () => groups.insert(market, group(`${tag} vip`)))).toBe(
        'name-taken',
      );
      expect(await inUnit(other, () => groups.insert(other, group(`${tag} VIP`)))).toBe('ok');
    });

    it('changes a group only under the version read', async () => {
      const made = group(`${tag} rename`);
      await inUnit(market, () => groups.insert(market, made));
      const change = {
        id: made.id,
        expectedVersion: 1,
        name: `${tag} renamed`,
        description: 'Cafés',
        archivedAt: null,
        updatedAt: T0.add({ minutes: 1 }),
      };
      expect(await inUnit(market, () => groups.update(market, change))).toBe('ok');
      expect(await inUnit(market, () => groups.update(market, change))).toBe('stale');
      const found = await inUnit(market, () => groups.find(market, made.id));
      expect([found?.name, found?.version, found?.description]).toEqual([
        `${tag} renamed`,
        2,
        'Cafés',
      ]);
      expect(await inUnit(other, () => groups.find(other, made.id))).toBeNull();
    });

    it('adds only the Market’s directory rows, once, and the list filters and shows the group', async () => {
      const made = group(`${tag} members`);
      await inUnit(market, () => groups.insert(market, made));
      const a = await customer();
      const b = await customer();
      const foreign = await customer(other);
      const added = await inUnit(market, () =>
        groups.addMembers(market, made.id, [a, b, foreign, ids.next<'Account'>()], admin, T0),
      );
      expect([...added].sort()).toEqual([a, b].sort());
      expect(
        await inUnit(market, () => groups.addMembers(market, made.id, [a], admin, T0)),
      ).toEqual([]);
      const found = await inUnit(market, () => groups.find(market, made.id));
      expect(found?.memberCount).toBe(2);
      const listed = await inUnit(market, () =>
        reader.ids(market, { selector: { ...BLANK, group: made.id }, now: T0, zone: 'UTC' }, 100),
      );
      expect([...listed].sort()).toEqual([a, b].sort());
      const [row] = await inUnit(market, () => reader.rowsByIds(market, [a]));
      expect(row?.groups).toEqual([{ groupId: made.id, name: `${tag} members`, archived: false }]);
      expect(await inUnit(market, () => groups.isMember(market, made.id, a))).toEqual({
        member: true,
        archived: false,
      });
      expect(await inUnit(other, () => groups.isMember(other, made.id, a))).toBeNull();
      const removed = await inUnit(market, () =>
        groups.removeMembers(market, made.id, [a, foreign]),
      );
      expect(removed).toEqual([a]);
      expect(await inUnit(market, () => groups.isMember(market, made.id, a))).toEqual({
        member: false,
        archived: false,
      });
    });

    it('adds and removes 2,500 customers at once, in slices, and counts each once', async () => {
      const made = group(`${tag} bulk`);
      await inUnit(market, () => groups.insert(market, made));
      const many: Id<'Account'>[] = [];
      // Seeded in units of 250 rows: one unit of 2,500 upserts can outrun the 5 s transaction
      // timeout on a busy database; the statement under test still gets all 2,500 at once.
      for (let start = 0; start < 2500; start += 250) {
        await inUnit(market, async () => {
          for (let n = start; n < start + 250; n += 1) {
            const accountId = ids.next<'Account'>();
            many.push(accountId);
            await models.upsertDirectory(
              market,
              {
                accountId,
                email: `${tag}.b${n}@example.test`,
                displayName: null,
                status: 'active',
                emailVerified: true,
                signedUpAt: T0,
              },
              T0,
            );
          }
        });
      }
      const added = await inUnit(market, () => groups.addMembers(market, made.id, many, admin, T0));
      expect(added).toHaveLength(2500);
      const entries = many.map((accountId) =>
        entry(accountId, {
          kind: 'group-added',
          ref: { type: 'group', id: made.id },
          actorAccountId: admin,
          sourceEventId: null,
        }),
      );
      expect(await inUnit(market, () => timeline.recordMany(market, entries, T0))).toBe(2500);
      const removed = await inUnit(market, () => groups.removeMembers(market, made.id, many));
      expect(removed).toHaveLength(2500);
    });

    it('refuses a name with a line break and a group of an unknown kind (CHECK)', async () => {
      await expect(
        sql.query(
          `INSERT INTO customers.customer_groups (id, market_id, tenant_id, name, kind,
             created_by_account_id, created_at, updated_at, version)
           VALUES ($1, $2, 'default', $3, 'manual', $4, now(), now(), 1)`,
          [ids.next(), market.marketId, `${tag}\nline`, admin],
        ),
      ).rejects.toThrow(/customer_groups/);
      await expect(
        sql.query(
          `INSERT INTO customers.customer_groups (id, market_id, tenant_id, name, kind,
             created_by_account_id, created_at, updated_at, version)
           VALUES ($1, $2, 'default', $3, 'smart', $4, now(), now(), 1)`,
          [ids.next(), market.marketId, `${tag} smart`, admin],
        ),
      ).rejects.toThrow(/customer_groups/);
    });
  });

  describe('notes', () => {
    it('pages newest first by a keyset, and counts per customer', async () => {
      const accountId = await customer();
      const written = [3, 2, 1].map((minutes) => ({
        id: ids.next<'CustomerNote'>(),
        accountId,
        authorAccountId: admin,
        bodySealed: SEALED,
        createdAt: at(minutes),
      }));
      await inUnit(market, async () => {
        for (const note of written) await notes.insert(market, note);
      });
      const first = await inUnit(market, () => notes.page(market, accountId, null, 2));
      expect(first.map((note) => note.id)).toEqual([written[2]!.id, written[1]!.id]);
      const last = first.at(-1)!;
      const next = await inUnit(market, () =>
        notes.page(market, accountId, { createdAt: last.createdAt, id: last.id }, 2),
      );
      expect(next.map((note) => note.id)).toEqual([written[0]!.id]);
      expect(await inUnit(market, () => notes.count(market, accountId))).toBe(3);
      expect(await inUnit(other, () => notes.count(other, accountId))).toBe(0);
    });

    it('refuses a body that is not a sealed value (CHECK)', async () => {
      const accountId = await customer();
      await expect(
        inUnit(market, () =>
          notes.insert(market, {
            id: ids.next<'CustomerNote'>(),
            accountId,
            authorAccountId: admin,
            bodySealed: 'plain text that is long enough to pass the length check',
            createdAt: T0,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('timeline', () => {
    it('writes an event once, only for a known customer, and filters and orders', async () => {
      const accountId = await customer();
      const source = ids.next();
      const paid = entry(accountId, {
        kind: 'order-paid',
        occurredAt: at(10),
        ref: { type: 'order', id: ids.next() },
        sourceEventId: source,
      });
      expect(await inUnit(market, () => timeline.record(market, paid, T0))).toBe(true);
      expect(
        await inUnit(market, () => timeline.record(market, { ...paid, id: ids.next() }, T0)),
      ).toBe(false);
      expect(await inUnit(market, () => timeline.record(market, entry(accountId), T0))).toBe(true);
      const stranger = ids.next<'Account'>();
      expect(await inUnit(market, () => timeline.record(market, entry(stranger), T0))).toBe(false);
      // The foreign key: no row for an account without a directory row, whatever the writer.
      await expect(
        sql.query(
          `INSERT INTO customers.customer_timeline (id, market_id, tenant_id, account_id, occurred_at,
             kind, recorded_at) VALUES ($1, $2, 'default', $3, now(), 'signed-up', now())`,
          [ids.next(), market.marketId, stranger],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      // One page-open row per admin, tab and day.
      const opened = (minutes: number) =>
        entry(accountId, {
          kind: 'page-opened',
          occurredAt: T0.add({ minutes }),
          actorAccountId: admin,
          detail: 'overview',
          sourceEventId: null,
        });
      const today = { onceSince: T0.subtract({ hours: 1 }) };
      expect(await inUnit(market, () => timeline.record(market, opened(1), T0, today))).toBe(true);
      expect(await inUnit(market, () => timeline.record(market, opened(2), T0, today))).toBe(false);
      const query = { accountId, kinds: null, from: null, to: null };
      const desc = await inUnit(market, () =>
        timeline.page(market, query, 'desc', { offset: 0, limit: 10 }),
      );
      expect(desc.map((row) => row.kind)).toEqual(['page-opened', 'signed-up', 'order-paid']);
      expect(desc[2]?.ref).toEqual(paid.ref);
      const orders = await inUnit(market, () =>
        timeline.page(market, { ...query, kinds: ['order-paid'] }, 'asc', { offset: 0, limit: 10 }),
      );
      expect(orders.map((row) => row.id)).toEqual([paid.id]);
      expect(
        await inUnit(market, () => timeline.count(market, { ...query, from: at(5), to: null })),
      ).toBe(2);
      expect(await inUnit(other, () => timeline.count(other, query))).toBe(0);
    });

    it('keeps a consent change with its channel as the detail, once per event (part 4)', async () => {
      const accountId = await customer();
      const consent = entry(accountId, { kind: 'consent-changed', detail: 'email' });
      expect(await inUnit(market, () => timeline.record(market, consent, T0))).toBe(true);
      expect(
        await inUnit(market, () => timeline.record(market, { ...consent, id: ids.next() }, T0)),
      ).toBe(false);
      const query = { accountId, kinds: ['consent-changed' as const], from: null, to: null };
      const rows = await inUnit(market, () =>
        timeline.page(market, query, 'desc', { offset: 0, limit: 10 }),
      );
      expect(rows.map((row) => [row.kind, row.detail, row.ref])).toEqual([
        ['consent-changed', 'email', null],
      ]);
      expect(await inUnit(other, () => timeline.count(other, query))).toBe(0);
    });

    it('records many admin entries in one statement', async () => {
      const a = await customer();
      const b = await customer();
      const written = await inUnit(market, () =>
        timeline.recordMany(
          market,
          [a, b, ids.next<'Account'>()].map((accountId) =>
            entry(accountId, {
              kind: 'group-added',
              ref: { type: 'group', id: ids.next() },
              actorAccountId: admin,
              sourceEventId: null,
            }),
          ),
          T0,
        ),
      );
      expect(written).toBe(2);
    });

    it('refuses a reference without its id and a kind outside the code alphabet (CHECK)', async () => {
      const accountId = await customer();
      await expect(
        inUnit(market, () =>
          timeline.record(market, entry(accountId, { kind: 'Order Paid' as never }), T0),
        ),
      ).rejects.toThrow();
      await expect(
        sql.query(
          `INSERT INTO customers.customer_timeline (id, market_id, tenant_id, account_id, occurred_at,
             kind, ref_type, recorded_at) VALUES ($1, $2, 'default', $3, now(), 'order-paid', 'order', now())`,
          [ids.next(), market.marketId, accountId],
        ),
      ).rejects.toThrow(/customer_timeline/);
    });
  });

  it('erasure takes the notes, the timeline and the memberships with the directory row', async () => {
    const accountId = await customer();
    const made = group(`${tag} erased`);
    await inUnit(market, async () => {
      await groups.insert(market, made);
      await groups.addMembers(market, made.id, [accountId], admin, T0);
      await notes.insert(market, {
        id: ids.next<'CustomerNote'>(),
        accountId,
        authorAccountId: admin,
        bodySealed: SEALED,
        createdAt: T0,
      });
      await timeline.record(market, entry(accountId), T0);
    });
    await inUnit(market, () => models.removeAllOf(market, accountId));
    for (const table of ['customer_notes', 'customer_timeline', 'customer_group_members']) {
      const left = await sql.query(
        `SELECT 1 FROM customers.${table} WHERE market_id = $1 AND account_id = $2`,
        [market.marketId, accountId],
      );
      expect([table, left.rowCount]).toEqual([table, 0]);
    }
    expect((await inUnit(market, () => groups.find(market, made.id)))?.memberCount).toBe(0);
  });
});
