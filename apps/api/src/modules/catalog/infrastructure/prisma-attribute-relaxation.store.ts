import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import {
  RelaxationAlreadyOpenError,
  type AttributeRelaxationStore,
} from '../application/ports/attribute-relaxation.store';
import {
  AttributeRelaxationRequest,
  type RelaxationCancelReason,
  type RelaxationKind,
  type RelaxationStatus,
} from '../domain/attribute-relaxation-request';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const KINDS: readonly string[] = ['clear-material', 'archive', 'remove-from-family'];
const STATUSES: readonly string[] = ['open', 'confirmed', 'cancelled', 'expired'];
const REASONS: readonly string[] = ['requester', 'definition-changed'];

const OPEN_KEY = 'attribute_relaxation_requests_open_definition_key';

interface Row {
  readonly id: string;
  readonly marketId: string;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly kind: string;
  readonly familyId: string | null;
  readonly status: string;
  readonly requestedByAccountId: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
  readonly confirmedByAccountId: string | null;
  readonly closedAt: Date | null;
  readonly cancelReason: string | null;
  readonly version: number;
}

/**
 * {@link AttributeRelaxationStore} on `catalog.attribute_relaxation_requests` (data design 3.21).
 * Every statement goes through `PrismaService.tx(market)` with `marketId` at the top level of
 * `where`. A move is one conditional update from `open` at the version read, in the granted
 * columns only; the guard trigger refuses any other change.
 */
export class PrismaAttributeRelaxationStore implements AttributeRelaxationStore {
  constructor(private readonly prisma: PrismaService) {}

  async findById(
    market: MarketContext,
    id: Id<'AttributeRelaxationRequest'>,
  ): Promise<AttributeRelaxationRequest | null> {
    const row = await this.prisma.tx(market).catalogAttributeRelaxationRequest.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : requestOf(row);
  }

  async openOf(
    market: MarketContext,
    definitionId: Id<'AttributeDefinition'>,
  ): Promise<AttributeRelaxationRequest | null> {
    const row = await this.prisma.tx(market).catalogAttributeRelaxationRequest.findFirst({
      where: { marketId: market.marketId, definitionId, status: 'open' },
    });
    return row === null ? null : requestOf(row);
  }

  async add(market: MarketContext, request: AttributeRelaxationRequest): Promise<void> {
    const state = request.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaAttributeRelaxationStore: the request is of another Market');
    }
    try {
      await this.prisma.tx(market).catalogAttributeRelaxationRequest.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          definitionId: state.definitionId,
          definitionVersion: state.definitionVersion,
          kind: state.kind,
          familyId: state.familyId,
          status: state.status,
          requestedByAccountId: state.requestedByAccountId,
          requestedAt: toDate(state.requestedAt),
          expiresAt: toDate(state.expiresAt),
          confirmedByAccountId: null,
          closedAt: null,
          cancelReason: null,
          version: state.version,
        },
        select: { id: true },
      });
    } catch (error) {
      if (isOpenViolation(error)) throw new RelaxationAlreadyOpenError();
      throw error;
    }
  }

  async saveMove(market: MarketContext, request: AttributeRelaxationRequest): Promise<void> {
    const state = request.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaAttributeRelaxationStore: the request is of another Market');
    }
    if (state.status === 'open' || state.closedAt === null) {
      throw new Error('PrismaAttributeRelaxationStore: a move leaves open');
    }
    const { count } = await this.prisma.tx(market).catalogAttributeRelaxationRequest.updateMany({
      where: {
        marketId: market.marketId,
        id: state.id,
        status: 'open',
        version: state.version - 1,
      },
      data: {
        status: state.status,
        confirmedByAccountId: state.confirmedByAccountId,
        closedAt: toDate(state.closedAt),
        cancelReason: state.cancelReason,
        version: state.version,
      },
    });
    if (count !== 1) throw new StaleAggregateError('attribute-relaxation-request', state.id);
  }

  async listOpen(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly AttributeRelaxationRequest[]> {
    const rows = await this.prisma.tx(market).catalogAttributeRelaxationRequest.findMany({
      where: { marketId: market.marketId, status: 'open', expiresAt: { gt: toDate(now) } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(requestOf);
  }

  async listExpired(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly AttributeRelaxationRequest[]> {
    const rows = await this.prisma.tx(market).catalogAttributeRelaxationRequest.findMany({
      where: { marketId: market.marketId, status: 'open', expiresAt: { lte: toDate(now) } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(requestOf);
  }
}

function oneOf<T extends string>(value: string, allowed: readonly string[], what: string): T {
  if (!allowed.includes(value)) {
    throw new Error(`PrismaAttributeRelaxationStore: unknown ${what} ${value}`);
  }
  return value as T;
}

function requestOf(row: Row): AttributeRelaxationRequest {
  return AttributeRelaxationRequest.rehydrate({
    id: row.id as Id<'AttributeRelaxationRequest'>,
    marketId: row.marketId as MarketId,
    definitionId: row.definitionId as Id<'AttributeDefinition'>,
    definitionVersion: row.definitionVersion,
    kind: oneOf<RelaxationKind>(row.kind, KINDS, 'kind'),
    familyId: row.familyId as Id<'AttributeFamily'> | null,
    status: oneOf<RelaxationStatus>(row.status, STATUSES, 'status'),
    requestedByAccountId: row.requestedByAccountId as Id<'Account'>,
    requestedAt: toInstant(row.requestedAt),
    expiresAt: toInstant(row.expiresAt),
    confirmedByAccountId: row.confirmedByAccountId as Id<'Account'> | null,
    closedAt: row.closedAt === null ? null : toInstant(row.closedAt),
    cancelReason:
      row.cancelReason === null
        ? null
        : oneOf<RelaxationCancelReason>(row.cancelReason, REASONS, 'cancel reason'),
    version: row.version,
  });
}

/**
 * A unique violation of the open partial unique (one open request per definition). Read from the
 * driver adapter's cause as the definition store reads its code key: the index name, or the last
 * quoted name of the PostgreSQL message. Any other unique violation stays an error.
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
