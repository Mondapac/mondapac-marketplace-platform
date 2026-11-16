import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CustomerGroupRepository,
  GroupChange,
} from '../application/ports/customer-groups.repository';
import type { CustomerGroup, CustomerGroupWithCount } from '../domain/customer-groups';

/** The case-insensitive name unique of the migration. */
const UNIQUE_NAME = 'customer_groups_name_key';

const instant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const date = (value: Temporal.Instant): Date => new Date(value.epochMilliseconds);

interface GroupRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly archivedAt: Date | null;
  readonly createdByAccountId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
  readonly _count: { readonly members: number };
}

const groupOf = (row: GroupRow): CustomerGroupWithCount => ({
  id: row.id as Id<'CustomerGroup'>,
  name: row.name,
  description: row.description,
  kind: 'manual',
  archivedAt: row.archivedAt === null ? null : instant(row.archivedAt),
  createdByAccountId: row.createdByAccountId as Id<'Account'>,
  createdAt: instant(row.createdAt),
  updatedAt: instant(row.updatedAt),
  version: row.version,
  memberCount: row._count.members,
});

/** {@link CustomerGroupRepository} on Prisma; `marketId` in every `where`, no raw SQL. */
export class PrismaCustomerGroupRepository implements CustomerGroupRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(market: MarketContext): Promise<readonly CustomerGroupWithCount[]> {
    const rows = await this.prisma.tx(market).customersCustomerGroup.findMany({
      where: { marketId: market.marketId },
      include: { _count: { select: { members: true } } },
      orderBy: [
        { archivedAt: { sort: 'desc', nulls: 'first' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });
    return rows.map(groupOf);
  }

  async find(market: MarketContext, id: Id<'CustomerGroup'>) {
    const row = await this.prisma.tx(market).customersCustomerGroup.findFirst({
      where: { marketId: market.marketId, id },
      include: { _count: { select: { members: true } } },
    });
    return row === null ? null : groupOf(row);
  }

  count(market: MarketContext): Promise<number> {
    return this.prisma
      .tx(market)
      .customersCustomerGroup.count({ where: { marketId: market.marketId } });
  }

  async insert(market: MarketContext, group: CustomerGroup): Promise<'ok' | 'name-taken'> {
    try {
      await this.prisma.tx(market).customersCustomerGroup.create({
        data: {
          id: group.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          name: group.name,
          description: group.description,
          kind: group.kind,
          archivedAt: group.archivedAt === null ? null : date(group.archivedAt),
          createdByAccountId: group.createdByAccountId,
          createdAt: date(group.createdAt),
          updatedAt: date(group.updatedAt),
          version: group.version,
        },
        select: { id: true },
      });
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === UNIQUE_NAME) return 'name-taken';
      throw error;
    }
    return 'ok';
  }

  async update(market: MarketContext, change: GroupChange): Promise<'ok' | 'stale' | 'name-taken'> {
    try {
      const { count } = await this.prisma.tx(market).customersCustomerGroup.updateMany({
        where: { marketId: market.marketId, id: change.id, version: change.expectedVersion },
        data: {
          name: change.name,
          description: change.description,
          archivedAt: change.archivedAt === null ? null : date(change.archivedAt),
          updatedAt: date(change.updatedAt),
          version: change.expectedVersion + 1,
        },
      });
      return count === 1 ? 'ok' : 'stale';
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === UNIQUE_NAME) return 'name-taken';
      throw error;
    }
  }

  async addMembers(
    market: MarketContext,
    groupId: Id<'CustomerGroup'>,
    accountIds: readonly Id<'Account'>[],
    addedBy: Id<'Account'>,
    at: Temporal.Instant,
  ): Promise<readonly Id<'Account'>[]> {
    const tx = this.prisma.tx(market);
    const added: Id<'Account'>[] = [];
    // In slices, so a "select all matching" of 10,000 stays far below the bind-parameter limit.
    for (const slice of slices([...new Set(accountIds)])) {
      const known = await tx.customersCustomerDirectory.findMany({
        where: { marketId: market.marketId, accountId: { in: slice } },
        select: { accountId: true },
      });
      if (known.length === 0) continue;
      // Only the rows this statement inserted come back: an existing member, or one a concurrent
      // add wrote first, is a skipped duplicate and is not counted twice.
      const inserted = await tx.customersCustomerGroupMember.createManyAndReturn({
        data: known.map((row) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          groupId,
          accountId: row.accountId,
          addedByAccountId: addedBy,
          addedAt: date(at),
        })),
        skipDuplicates: true,
        select: { accountId: true },
      });
      for (const row of inserted) added.push(row.accountId as Id<'Account'>);
    }
    return added.sort();
  }

  async removeMembers(
    market: MarketContext,
    groupId: Id<'CustomerGroup'>,
    accountIds: readonly Id<'Account'>[],
  ): Promise<readonly Id<'Account'>[]> {
    const tx = this.prisma.tx(market);
    const removed: Id<'Account'>[] = [];
    for (const slice of slices([...new Set(accountIds)])) {
      const present = await tx.customersCustomerGroupMember.findMany({
        where: { marketId: market.marketId, groupId, accountId: { in: slice } },
        select: { accountId: true },
      });
      const ids = present.map((row) => row.accountId);
      if (ids.length === 0) continue;
      await tx.customersCustomerGroupMember.deleteMany({
        where: { marketId: market.marketId, groupId, accountId: { in: ids } },
      });
      for (const id of ids) removed.push(id as Id<'Account'>);
    }
    return removed.sort();
  }

  async groupsOf(market: MarketContext, accountIds: readonly Id<'Account'>[]) {
    const out = new Map<
      Id<'Account'>,
      { id: Id<'CustomerGroup'>; name: string; archived: boolean }[]
    >();
    if (accountIds.length === 0) return out;
    const rows = await this.prisma.tx(market).customersCustomerGroupMember.findMany({
      where: { marketId: market.marketId, accountId: { in: [...accountIds] } },
      select: {
        accountId: true,
        group: { select: { id: true, name: true, archivedAt: true } },
      },
      orderBy: [{ addedAt: 'asc' }, { groupId: 'asc' }],
    });
    for (const row of rows) {
      const accountId = row.accountId as Id<'Account'>;
      const list = out.get(accountId) ?? [];
      list.push({
        id: row.group.id as Id<'CustomerGroup'>,
        name: row.group.name,
        archived: row.group.archivedAt !== null,
      });
      out.set(accountId, list);
    }
    return out;
  }

  async isMember(market: MarketContext, groupId: Id<'CustomerGroup'>, accountId: Id<'Account'>) {
    const tx = this.prisma.tx(market);
    const group = await tx.customersCustomerGroup.findFirst({
      where: { marketId: market.marketId, id: groupId },
      select: { archivedAt: true },
    });
    if (group === null) return null;
    const member = await tx.customersCustomerGroupMember.findFirst({
      where: { marketId: market.marketId, groupId, accountId },
      select: { accountId: true },
    });
    return { member: member !== null, archived: group.archivedAt !== null };
  }
}

/** Statements of at most this many customers (six columns each: far below 32,767 parameters). */
const SLICE = 1000;

function slices<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += SLICE)
    out.push(items.slice(start, start + SLICE));
  return out;
}
