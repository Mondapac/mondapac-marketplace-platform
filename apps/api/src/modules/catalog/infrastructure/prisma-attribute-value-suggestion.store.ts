import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { AttributeValueSuggestionStore } from '../application/ports/attribute-value-suggestion.store';
import {
  AttributeValueSuggestion,
  type SuggestionNoticeState,
  type SuggestionStatus,
} from '../domain/attribute-value-suggestion';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const STATUSES: readonly string[] = ['open', 'approved', 'mapped', 'rejected'];
const NOTICES: readonly string[] = ['none', 'pending', 'sent', 'skipped', 'failed'];
const OPEN_KEY = 'attribute_value_suggestions_open_product_definition_key';

interface Row {
  readonly id: string;
  readonly marketId: string;
  readonly definitionId: string;
  readonly sellerId: string;
  readonly productId: string;
  readonly label: string;
  readonly status: string;
  readonly optionCode: string | null;
  readonly rejectReason: string | null;
  readonly decidedByAccountId: string | null;
  readonly decidedAt: Date | null;
  readonly noticeState: string;
  readonly noticeAttempts: number;
  readonly noticeNextAttemptAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
}

/**
 * {@link AttributeValueSuggestionStore} on `catalog.attribute_value_suggestions` (data design
 * 3.30). Every statement goes through `PrismaService.tx(market)` with `marketId` at the top level
 * of `where`. A decision and a notice move are each one conditional update at the version read,
 * in the granted columns only; the guard trigger refuses any other change.
 */
export class PrismaAttributeValueSuggestionStore implements AttributeValueSuggestionStore {
  constructor(private readonly prisma: PrismaService) {}

  async findById(
    market: MarketContext,
    id: Id<'AttributeValueSuggestion'>,
  ): Promise<AttributeValueSuggestion | null> {
    const row = await this.prisma.tx(market).catalogAttributeValueSuggestion.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : suggestionOf(row);
  }

  async add(
    market: MarketContext,
    suggestion: AttributeValueSuggestion,
  ): Promise<'suggestion.already-open' | null> {
    const state = suggestion.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaAttributeValueSuggestionStore: the suggestion is of another Market');
    }
    try {
      await this.prisma.tx(market).catalogAttributeValueSuggestion.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          definitionId: state.definitionId,
          sellerId: state.sellerId,
          productId: state.productId,
          label: state.label,
          status: 'open',
          optionCode: null,
          rejectReason: null,
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
      if (isOpenViolation(error)) return 'suggestion.already-open';
      throw error;
    }
  }

  async saveDecision(market: MarketContext, suggestion: AttributeValueSuggestion): Promise<void> {
    const state = suggestion.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaAttributeValueSuggestionStore: the suggestion is of another Market');
    }
    if (state.status === 'open' || state.decidedAt === null || state.noticeState !== 'pending') {
      throw new Error('PrismaAttributeValueSuggestionStore: a decision leaves open');
    }
    const { count } = await this.prisma.tx(market).catalogAttributeValueSuggestion.updateMany({
      where: {
        marketId: market.marketId,
        id: state.id,
        status: 'open',
        version: state.version - 1,
      },
      data: {
        status: state.status,
        optionCode: state.optionCode,
        rejectReason: state.rejectReason,
        decidedByAccountId: state.decidedByAccountId,
        decidedAt: toDate(state.decidedAt),
        noticeState: state.noticeState,
        noticeAttempts: state.noticeAttempts,
        noticeNextAttemptAt:
          state.noticeNextAttemptAt === null ? null : toDate(state.noticeNextAttemptAt),
        version: state.version,
      },
    });
    if (count !== 1) throw new StaleAggregateError('attribute-value-suggestion', state.id);
  }

  async saveNotice(market: MarketContext, suggestion: AttributeValueSuggestion): Promise<void> {
    const state = suggestion.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaAttributeValueSuggestionStore: the suggestion is of another Market');
    }
    const { count } = await this.prisma.tx(market).catalogAttributeValueSuggestion.updateMany({
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
    if (count !== 1) throw new StaleAggregateError('attribute-value-suggestion', state.id);
  }

  openCountOfSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<number> {
    return this.prisma.tx(market).catalogAttributeValueSuggestion.count({
      where: { marketId: market.marketId, sellerId, status: 'open' },
    });
  }

  async listOpen(
    market: MarketContext,
    limit: number,
  ): Promise<readonly AttributeValueSuggestion[]> {
    const rows = await this.prisma.tx(market).catalogAttributeValueSuggestion.findMany({
      where: { marketId: market.marketId, status: 'open' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(suggestionOf);
  }

  async listOfProduct(
    market: MarketContext,
    productId: Id<'Product'>,
    limit: number,
  ): Promise<readonly AttributeValueSuggestion[]> {
    const rows = await this.prisma.tx(market).catalogAttributeValueSuggestion.findMany({
      where: { marketId: market.marketId, productId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(suggestionOf);
  }

  async listOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: {
      readonly status: SuggestionStatus | null;
      readonly afterId: Id<'AttributeValueSuggestion'> | null;
      readonly limit: number;
    },
  ): Promise<readonly AttributeValueSuggestion[]> {
    const rows = await this.prisma.tx(market).catalogAttributeValueSuggestion.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        ...(page.status === null ? {} : { status: page.status }),
        ...(page.afterId === null ? {} : { id: { lt: page.afterId } }),
      },
      orderBy: [{ id: 'desc' }],
      take: page.limit,
    });
    return rows.map(suggestionOf);
  }

  async openAttributeCodesOfProduct(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<ReadonlySet<string>> {
    const open = await this.prisma.tx(market).catalogAttributeValueSuggestion.findMany({
      where: { marketId: market.marketId, productId, status: 'open' },
      select: { definitionId: true },
    });
    if (open.length === 0) return new Set();
    const definitions = await this.prisma.tx(market).catalogAttributeDefinition.findMany({
      where: { marketId: market.marketId, id: { in: open.map((row) => row.definitionId) } },
      select: { code: true },
    });
    return new Set(definitions.map((definition) => definition.code));
  }

  async dueNotices(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly AttributeValueSuggestion[]> {
    const rows = await this.prisma.tx(market).catalogAttributeValueSuggestion.findMany({
      where: {
        marketId: market.marketId,
        noticeState: 'pending',
        noticeNextAttemptAt: { lte: toDate(now) },
      },
      orderBy: [{ noticeNextAttemptAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(suggestionOf);
  }
}

function oneOf<T extends string>(value: string, allowed: readonly string[], what: string): T {
  if (!allowed.includes(value)) {
    throw new Error(`PrismaAttributeValueSuggestionStore: unknown ${what} ${value}`);
  }
  return value as T;
}

function suggestionOf(row: Row): AttributeValueSuggestion {
  return AttributeValueSuggestion.rehydrate({
    id: row.id as Id<'AttributeValueSuggestion'>,
    marketId: row.marketId as MarketId,
    definitionId: row.definitionId as Id<'AttributeDefinition'>,
    sellerId: row.sellerId as Id<'Seller'>,
    productId: row.productId as Id<'Product'>,
    label: row.label,
    status: oneOf<SuggestionStatus>(row.status, STATUSES, 'status'),
    optionCode: row.optionCode,
    rejectReason: row.rejectReason,
    decidedByAccountId: row.decidedByAccountId as Id<'Account'> | null,
    decidedAt: row.decidedAt === null ? null : toInstant(row.decidedAt),
    noticeState: oneOf<SuggestionNoticeState>(row.noticeState, NOTICES, 'notice state'),
    noticeAttempts: row.noticeAttempts,
    noticeNextAttemptAt:
      row.noticeNextAttemptAt === null ? null : toInstant(row.noticeNextAttemptAt),
    version: row.version,
    createdAt: toInstant(row.createdAt),
  });
}

/**
 * A unique violation of the open partial unique (one open suggestion per product and attribute).
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
