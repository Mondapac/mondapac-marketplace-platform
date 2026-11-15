import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ActivityRecord,
  DecisionWrite,
  Direction,
  NewRequest,
  PageWindow,
  RequestFilter,
  RequestRepository,
  RequestSort,
} from '../application/ports/request.repository';
import type { ReviewArea, Risk } from '../domain/areas';
import type {
  ActivityKind,
  ChangeValues,
  Decision,
  RequestStatus,
  SystemRequest,
} from '../domain/request';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  readonly id: string;
  readonly number: number;
  readonly area: string;
  readonly subjectKind: string;
  readonly subjectRef: string;
  readonly risk: string;
  readonly status: string;
  readonly before: Prisma.JsonValue;
  readonly after: Prisma.JsonValue;
  readonly note: string;
  readonly requestedByAccountId: string;
  readonly appliedAt: Date;
  readonly reviewDueAt: Date;
  readonly decision: string | null;
  readonly decidedByAccountId: string | null;
  readonly decidedAt: Date | null;
  readonly decisionReason: string | null;
  readonly supersededByRequestId: string | null;
  readonly commentCount: number;
}

const toRequest = (row: Row): SystemRequest => ({
  id: row.id as Id<'SystemRequest'>,
  number: row.number,
  area: row.area as ReviewArea,
  subjectKind: row.subjectKind,
  subjectRef: row.subjectRef,
  risk: row.risk as Risk,
  status: row.status as RequestStatus,
  before: row.before as ChangeValues,
  after: row.after as ChangeValues,
  note: row.note,
  requestedBy: row.requestedByAccountId as Id<'Account'>,
  appliedAt: toInstant(row.appliedAt),
  reviewDueAt: toInstant(row.reviewDueAt),
  decision: row.decision as Decision | null,
  decidedBy: row.decidedByAccountId as Id<'Account'> | null,
  decidedAt: row.decidedAt === null ? null : toInstant(row.decidedAt),
  decisionReason: row.decisionReason,
  supersededBy: row.supersededByRequestId as Id<'SystemRequest'> | null,
  commentCount: row.commentCount,
});

const SORT_COLUMN: Readonly<Record<RequestSort, 'appliedAt' | 'reviewDueAt' | 'number'>> = {
  applied: 'appliedAt',
  due: 'reviewDueAt',
  number: 'number',
};

/** `%` and `_` in a search are text, not wildcards (Prisma's contains escapes nothing). */
const literal = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

function whereOf(
  market: MarketContext,
  filter: RequestFilter,
): Prisma.SystemRequestsRequestWhereInput {
  const and: Prisma.SystemRequestsRequestWhereInput[] = [];
  if (filter.text !== undefined) {
    const contains = literal(filter.text);
    and.push({
      OR: [
        { note: { contains, mode: 'insensitive' } },
        { subjectKind: { contains, mode: 'insensitive' } },
        { subjectRef: { contains, mode: 'insensitive' } },
      ],
    });
  }
  if (filter.appliedFrom !== undefined || filter.appliedBefore !== undefined) {
    and.push({
      appliedAt: {
        ...(filter.appliedFrom === undefined ? {} : { gte: toDate(filter.appliedFrom) }),
        ...(filter.appliedBefore === undefined ? {} : { lt: toDate(filter.appliedBefore) }),
      },
    });
  }
  if (filter.dueBy !== undefined) {
    and.push({ status: 'open', reviewDueAt: { lte: toDate(filter.dueBy) } });
  }
  return {
    marketId: market.marketId,
    ...(filter.statuses === undefined ? {} : { status: { in: [...filter.statuses] } }),
    ...(filter.areas === undefined ? {} : { area: { in: [...filter.areas] } }),
    ...(filter.risks === undefined ? {} : { risk: { in: [...filter.risks] } }),
    ...(filter.requestedBy === undefined && filter.notRequestedBy === undefined
      ? {}
      : {
          requestedByAccountId: {
            ...(filter.requestedBy === undefined ? {} : { equals: filter.requestedBy }),
            ...(filter.notRequestedBy === undefined ? {} : { not: filter.notRequestedBy }),
          },
        }),
    ...(filter.decidedBy === undefined ? {} : { decidedByAccountId: filter.decidedBy }),
    ...(filter.subjectKind === undefined ? {} : { subjectKind: filter.subjectKind }),
    ...(filter.subjectRef === undefined ? {} : { subjectRef: filter.subjectRef }),
    ...(filter.number === undefined ? {} : { number: filter.number }),
    ...(and.length === 0 ? {} : { AND: and }),
  };
}

/**
 * {@link RequestRepository} on `system_requests.requests`, `request_activity` and
 * `request_counters`, scoped by `marketId` in every `where`. A row lock is a no-change update of
 * the status (as wallet's credit requests take theirs).
 */
export class PrismaRequestRepository implements RequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async open(market: MarketContext, request: NewRequest, activityId: Id<'SystemRequestActivity'>) {
    const tx = this.prisma.tx(market);
    // The counter: the first opening of a Market creates the row; every later one increments it
    // under the row lock, so two openings of one Market get consecutive numbers.
    await tx.systemRequestsRequestCounter.createMany({
      data: [{ marketId: market.marketId, tenantId: market.tenantId, lastNumber: 0 }],
      skipDuplicates: true,
    });
    const counter = await tx.systemRequestsRequestCounter.update({
      where: { marketId: market.marketId },
      data: { lastNumber: { increment: 1 } },
      select: { lastNumber: true },
    });
    const earlier = await tx.systemRequestsRequest.findMany({
      where: {
        marketId: market.marketId,
        subjectKind: request.subjectKind,
        subjectRef: request.subjectRef,
        supersededByRequestId: null,
      },
      select: { id: true },
    });
    await tx.systemRequestsRequest.create({
      data: {
        id: request.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        number: counter.lastNumber,
        area: request.area,
        subjectKind: request.subjectKind,
        subjectRef: request.subjectRef,
        risk: request.risk,
        status: 'open',
        before: request.before as Prisma.InputJsonValue,
        after: request.after as Prisma.InputJsonValue,
        note: request.note,
        requestedByAccountId: request.requestedBy,
        appliedAt: toDate(request.appliedAt),
        reviewDueAt: toDate(request.reviewDueAt),
      },
    });
    const superseded = earlier.map((row) => row.id as Id<'SystemRequest'>);
    if (superseded.length > 0) {
      await tx.systemRequestsRequest.updateMany({
        where: { marketId: market.marketId, id: { in: superseded }, supersededByRequestId: null },
        data: { supersededByRequestId: request.id },
      });
    }
    await tx.systemRequestsActivity.create({
      data: {
        id: activityId,
        marketId: market.marketId,
        tenantId: market.tenantId,
        requestId: request.id,
        kind: 'applied',
        actorAccountId: request.requestedBy,
        at: toDate(request.appliedAt),
        body: null,
      },
    });
    return { number: counter.lastNumber, superseded };
  }

  async find(market: MarketContext, id: Id<'SystemRequest'>) {
    const row = await this.prisma
      .tx(market)
      .systemRequestsRequest.findFirst({ where: { marketId: market.marketId, id } });
    return row === null ? null : toRequest(row);
  }

  async findForUpdate(market: MarketContext, id: Id<'SystemRequest'>) {
    const tx = this.prisma.tx(market);
    const seen = await tx.systemRequestsRequest.findFirst({
      where: { marketId: market.marketId, id },
      select: { status: true },
    });
    if (seen === null) return null;
    // A no-change update takes the row lock; the read after it sees what was committed before.
    await tx.systemRequestsRequest.updateMany({
      where: { marketId: market.marketId, id, status: seen.status },
      data: { status: seen.status },
    });
    return this.find(market, id);
  }

  async findMany(market: MarketContext, ids: readonly Id<'SystemRequest'>[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).systemRequestsRequest.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
    });
    return rows.map(toRequest);
  }

  async decide(market: MarketContext, id: Id<'SystemRequest'>, decision: DecisionWrite) {
    const updated = await this.prisma.tx(market).systemRequestsRequest.updateMany({
      where: { marketId: market.marketId, id, status: 'open' },
      data: {
        status: decision.status,
        decision: decision.decision,
        decidedByAccountId: decision.decidedBy,
        decidedAt: toDate(decision.decidedAt),
        decisionReason: decision.reason,
      },
    });
    return updated.count === 1;
  }

  async addActivity(
    market: MarketContext,
    requestId: Id<'SystemRequest'>,
    activity: ActivityRecord,
  ) {
    await this.prisma.tx(market).systemRequestsActivity.create({
      data: {
        id: activity.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        requestId,
        kind: activity.kind,
        actorAccountId: activity.actor,
        at: toDate(activity.at),
        body: activity.body,
      },
    });
  }

  async addComment(
    market: MarketContext,
    requestId: Id<'SystemRequest'>,
    activity: ActivityRecord,
  ) {
    await this.addActivity(market, requestId, activity);
    const tx = this.prisma.tx(market);
    await tx.systemRequestsRequest.updateMany({
      where: { marketId: market.marketId, id: requestId },
      data: { commentCount: { increment: 1 } },
    });
    const row = await tx.systemRequestsRequest.findFirst({
      where: { marketId: market.marketId, id: requestId },
      select: { commentCount: true },
    });
    return row?.commentCount ?? 0;
  }

  async activity(market: MarketContext, id: Id<'SystemRequest'>) {
    const rows = await this.prisma.tx(market).systemRequestsActivity.findMany({
      where: { marketId: market.marketId, requestId: id },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row): ActivityRecord => ({
      id: row.id as Id<'SystemRequestActivity'>,
      kind: row.kind as ActivityKind,
      actor: row.actorAccountId as Id<'Account'>,
      at: toInstant(row.at),
      body: row.body,
    }));
  }

  async page(
    market: MarketContext,
    filter: RequestFilter,
    sort: RequestSort,
    direction: Direction,
    window: PageWindow,
  ) {
    const column = SORT_COLUMN[sort];
    let where = whereOf(market, filter);
    if (window.kind === 'keyset' && window.after !== null) {
      const op = direction === 'asc' ? 'gt' : 'lt';
      const value =
        typeof window.after.value === 'number' ? window.after.value : toDate(window.after.value);
      const keyset: Prisma.SystemRequestsRequestWhereInput =
        column === 'number'
          ? { number: { [op]: window.after.number } }
          : {
              OR: [
                { [column]: { [op]: value } },
                { [column]: value, number: { [op]: window.after.number } },
              ],
            };
      where = {
        ...where,
        AND: [...((where.AND as Prisma.SystemRequestsRequestWhereInput[]) ?? []), keyset],
      };
    }
    const orderBy: Prisma.SystemRequestsRequestOrderByWithRelationInput[] =
      column === 'number'
        ? [{ number: direction }]
        : [{ [column]: direction }, { number: direction }];
    const rows = await this.prisma.tx(market).systemRequestsRequest.findMany({
      where,
      orderBy,
      ...(window.kind === 'offset' ? { skip: window.offset } : {}),
      take: window.limit,
    });
    return rows.map(toRequest);
  }

  async count(market: MarketContext, filter: RequestFilter, cap: number) {
    return this.prisma.tx(market).systemRequestsRequest.count({
      where: whereOf(market, filter),
      take: cap,
    });
  }
}
