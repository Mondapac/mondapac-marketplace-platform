import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { VariantRequestStore } from '../application/ports/variant-request.store';
import {
  VariantRequest,
  type VariantRequestNoticeState,
  type VariantRequestStatus,
} from '../domain/variant-request';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const STATUSES: readonly string[] = ['open', 'approved', 'mapped', 'declined'];
const NOTICES: readonly string[] = ['none', 'pending', 'sent', 'skipped', 'failed'];
const OPEN_KEY = 'variant_requests_open_offer_option_key';

interface Row {
  readonly id: string;
  readonly marketId: string;
  readonly sellerId: string;
  readonly offerId: string;
  readonly productId: string;
  readonly optionValues: unknown;
  readonly optionKey: string;
  readonly status: string;
  readonly resolvedVariantId: string | null;
  readonly declineReason: string | null;
  readonly decidedByAccountId: string | null;
  readonly decidedAt: Date | null;
  readonly noticeState: string;
  readonly noticeAttempts: number;
  readonly noticeNextAttemptAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
}

/**
 * {@link VariantRequestStore} on `catalog.variant_requests`. Every statement goes through
 * `PrismaService.tx(market)` with `marketId` at the top level of `where`. A decision and a notice
 * move are each one conditional update at the version read, in the granted columns only; the guard
 * trigger refuses any other change.
 */
export class PrismaVariantRequestStore implements VariantRequestStore {
  constructor(private readonly prisma: PrismaService) {}

  async findById(market: MarketContext, id: Id<'VariantRequest'>): Promise<VariantRequest | null> {
    const row = await this.prisma.tx(market).catalogVariantRequest.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : requestOf(row);
  }

  async add(
    market: MarketContext,
    request: VariantRequest,
  ): Promise<'variant-request.already-open' | null> {
    const state = request.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaVariantRequestStore: the request is of another Market');
    }
    try {
      await this.prisma.tx(market).catalogVariantRequest.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: state.sellerId,
          offerId: state.offerId,
          productId: state.productId,
          optionValues: { ...state.optionValues },
          optionKey: state.optionKey,
          status: 'open',
          resolvedVariantId: null,
          declineReason: null,
          decidedByAccountId: null,
          decidedAt: null,
          noticeState: 'none',
          noticeAttempts: 0,
          noticeNextAttemptAt: null,
          version: state.version,
          createdAt: toDate(state.createdAt),
        },
        select: { id: true },
      });
      return null;
    } catch (error) {
      if (isOpenViolation(error)) return 'variant-request.already-open';
      throw error;
    }
  }

  async saveDecision(market: MarketContext, request: VariantRequest): Promise<void> {
    const state = request.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaVariantRequestStore: the request is of another Market');
    }
    if (state.status === 'open' || state.decidedAt === null || state.noticeState !== 'pending') {
      throw new Error('PrismaVariantRequestStore: a decision leaves open');
    }
    const { count } = await this.prisma.tx(market).catalogVariantRequest.updateMany({
      where: {
        marketId: market.marketId,
        id: state.id,
        status: 'open',
        version: state.version - 1,
      },
      data: {
        status: state.status,
        resolvedVariantId: state.resolvedVariantId,
        declineReason: state.declineReason,
        decidedByAccountId: state.decidedByAccountId,
        decidedAt: toDate(state.decidedAt),
        noticeState: state.noticeState,
        noticeAttempts: state.noticeAttempts,
        noticeNextAttemptAt:
          state.noticeNextAttemptAt === null ? null : toDate(state.noticeNextAttemptAt),
        version: state.version,
      },
    });
    if (count !== 1) throw new StaleAggregateError('variant-request', state.id);
  }

  async saveNotice(market: MarketContext, request: VariantRequest): Promise<void> {
    const state = request.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaVariantRequestStore: the request is of another Market');
    }
    const { count } = await this.prisma.tx(market).catalogVariantRequest.updateMany({
      where: {
        marketId: market.marketId,
        id: state.id,
        noticeState: 'pending',
        version: state.version - 1,
      },
      data: {
        noticeState: state.noticeState,
        noticeAttempts: state.noticeAttempts,
        noticeNextAttemptAt:
          state.noticeNextAttemptAt === null ? null : toDate(state.noticeNextAttemptAt),
        version: state.version,
      },
    });
    if (count !== 1) throw new StaleAggregateError('variant-request', state.id);
  }

  openCountOfSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<number> {
    return this.prisma.tx(market).catalogVariantRequest.count({
      where: { marketId: market.marketId, sellerId, status: 'open' },
    });
  }

  madeSince(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    since: Temporal.Instant,
  ): Promise<number> {
    return this.prisma.tx(market).catalogVariantRequest.count({
      where: { marketId: market.marketId, sellerId, createdAt: { gte: toDate(since) } },
    });
  }

  async listOpen(market: MarketContext, limit: number): Promise<readonly VariantRequest[]> {
    const rows = await this.prisma.tx(market).catalogVariantRequest.findMany({
      where: { marketId: market.marketId, status: 'open' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(requestOf);
  }

  async listOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: {
      readonly status: VariantRequestStatus | null;
      readonly afterId: Id<'VariantRequest'> | null;
      readonly limit: number;
    },
  ): Promise<readonly VariantRequest[]> {
    const rows = await this.prisma.tx(market).catalogVariantRequest.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        ...(page.status === null ? {} : { status: page.status }),
        ...(page.afterId === null ? {} : { id: { lt: page.afterId } }),
      },
      orderBy: [{ id: 'desc' }],
      take: page.limit,
    });
    return rows.map(requestOf);
  }

  async dueNotices(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly VariantRequest[]> {
    const rows = await this.prisma.tx(market).catalogVariantRequest.findMany({
      where: {
        marketId: market.marketId,
        noticeState: 'pending',
        noticeNextAttemptAt: { lte: toDate(now) },
      },
      orderBy: [{ noticeNextAttemptAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(requestOf);
  }
}

function oneOf<T extends string>(value: string, allowed: readonly string[], what: string): T {
  if (!allowed.includes(value)) {
    throw new Error(`PrismaVariantRequestStore: unknown ${what} ${value}`);
  }
  return value as T;
}

function optionValuesOf(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('PrismaVariantRequestStore: the option values are not an object');
  }
  const values: Record<string, string> = {};
  for (const [axis, option] of Object.entries(raw)) {
    if (typeof option !== 'string') {
      throw new Error('PrismaVariantRequestStore: an option value is not a string');
    }
    values[axis] = option;
  }
  return values;
}

function requestOf(row: Row): VariantRequest {
  return VariantRequest.rehydrate({
    id: row.id as Id<'VariantRequest'>,
    marketId: row.marketId as MarketId,
    sellerId: row.sellerId as Id<'Seller'>,
    offerId: row.offerId as Id<'Offer'>,
    productId: row.productId as Id<'Product'>,
    optionValues: optionValuesOf(row.optionValues),
    optionKey: row.optionKey,
    status: oneOf<VariantRequestStatus>(row.status, STATUSES, 'status'),
    resolvedVariantId: row.resolvedVariantId as Id<'Variant'> | null,
    declineReason: row.declineReason,
    decidedByAccountId: row.decidedByAccountId as Id<'Account'> | null,
    decidedAt: row.decidedAt === null ? null : toInstant(row.decidedAt),
    noticeState: oneOf<VariantRequestNoticeState>(row.noticeState, NOTICES, 'notice state'),
    noticeAttempts: row.noticeAttempts,
    noticeNextAttemptAt:
      row.noticeNextAttemptAt === null ? null : toInstant(row.noticeNextAttemptAt),
    version: row.version,
    createdAt: toInstant(row.createdAt),
  });
}

/**
 * A unique violation of the open partial unique (one open request per Offer and combination).
 * Read from the driver adapter's cause as the relaxation store reads its key: the index name, or
 * the quoted name in the PostgreSQL message. Any other unique violation stays an error.
 */
function isOpenViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code !== 'P2002') return false;
  const cause = (
    error as {
      meta?: {
        driverAdapterError?: {
          cause?: { constraint?: { index?: unknown }; originalMessage?: unknown };
        };
      };
    }
  ).meta?.driverAdapterError?.cause;
  if (cause?.constraint?.index === OPEN_KEY) return true;
  const message = cause?.originalMessage;
  return typeof message === 'string' && message.includes(`"${OPEN_KEY}"`);
}
