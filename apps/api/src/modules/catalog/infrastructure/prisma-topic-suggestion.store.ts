import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { TopicSuggestionStore } from '../application/ports/topic-suggestion.store';
import {
  TopicSuggestion,
  type SuggestionNoticeState,
  type SuggestionStatus,
} from '../domain/topic-suggestion';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const STATUSES: readonly string[] = ['open', 'approved', 'mapped', 'rejected'];
const NOTICES: readonly string[] = ['none', 'pending', 'sent', 'skipped', 'failed'];
const OPEN_KEY = 'topic_suggestions_open_seller_label_key';

interface Row {
  readonly id: string;
  readonly marketId: string;
  readonly sellerId: string;
  readonly productId: string;
  readonly label: string;
  readonly labelKey: string;
  readonly status: string;
  readonly topicId: string | null;
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
 * {@link TopicSuggestionStore} on `catalog.topic_suggestions` (product tags package T5). Every statement goes through `PrismaService.tx(market)` with `marketId` at the top level
 * of `where`. A decision and a notice move are each one conditional update at the version read,
 * in the granted columns only; the guard trigger refuses any other change.
 */
export class PrismaTopicSuggestionStore implements TopicSuggestionStore {
  constructor(private readonly prisma: PrismaService) {}

  async findById(
    market: MarketContext,
    id: Id<'TopicSuggestion'>,
  ): Promise<TopicSuggestion | null> {
    const row = await this.prisma.tx(market).catalogTopicSuggestion.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : suggestionOf(row);
  }

  async add(
    market: MarketContext,
    suggestion: TopicSuggestion,
  ): Promise<'suggestion.already-open' | null> {
    const state = suggestion.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaTopicSuggestionStore: the suggestion is of another Market');
    }
    try {
      await this.prisma.tx(market).catalogTopicSuggestion.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: state.sellerId,
          productId: state.productId,
          label: state.label,
          labelKey: state.labelKey,
          status: 'open',
          topicId: null,
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

  async saveDecision(market: MarketContext, suggestion: TopicSuggestion): Promise<void> {
    const state = suggestion.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaTopicSuggestionStore: the suggestion is of another Market');
    }
    if (state.status === 'open' || state.decidedAt === null || state.noticeState !== 'pending') {
      throw new Error('PrismaTopicSuggestionStore: a decision leaves open');
    }
    const { count } = await this.prisma.tx(market).catalogTopicSuggestion.updateMany({
      where: {
        marketId: market.marketId,
        id: state.id,
        status: 'open',
        version: state.version - 1,
      },
      data: {
        status: state.status,
        topicId: state.topicId,
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
    if (count !== 1) throw new StaleAggregateError('topic-suggestion', state.id);
  }

  async saveNotice(market: MarketContext, suggestion: TopicSuggestion): Promise<void> {
    const state = suggestion.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaTopicSuggestionStore: the suggestion is of another Market');
    }
    const { count } = await this.prisma.tx(market).catalogTopicSuggestion.updateMany({
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
    if (count !== 1) throw new StaleAggregateError('topic-suggestion', state.id);
  }

  openCountOfSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<number> {
    return this.prisma.tx(market).catalogTopicSuggestion.count({
      where: { marketId: market.marketId, sellerId, status: 'open' },
    });
  }

  async listOpen(market: MarketContext, limit: number): Promise<readonly TopicSuggestion[]> {
    const rows = await this.prisma.tx(market).catalogTopicSuggestion.findMany({
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
  ): Promise<readonly TopicSuggestion[]> {
    const rows = await this.prisma.tx(market).catalogTopicSuggestion.findMany({
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
      readonly afterId: Id<'TopicSuggestion'> | null;
      readonly limit: number;
    },
  ): Promise<readonly TopicSuggestion[]> {
    const rows = await this.prisma.tx(market).catalogTopicSuggestion.findMany({
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

  async dueNotices(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly TopicSuggestion[]> {
    const rows = await this.prisma.tx(market).catalogTopicSuggestion.findMany({
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
    throw new Error(`PrismaTopicSuggestionStore: unknown ${what} ${value}`);
  }
  return value as T;
}

function suggestionOf(row: Row): TopicSuggestion {
  return TopicSuggestion.rehydrate({
    id: row.id as Id<'TopicSuggestion'>,
    marketId: row.marketId as MarketId,
    sellerId: row.sellerId as Id<'Seller'>,
    productId: row.productId as Id<'Product'>,
    label: row.label,
    labelKey: row.labelKey,
    status: oneOf<SuggestionStatus>(row.status, STATUSES, 'status'),
    topicId: row.topicId as Id<'Topic'> | null,
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
 * A unique violation of the open partial unique (one open suggestion per seller and text key).
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
