import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { MissingDetailsEmailStore } from '../application/ports/missing-details-email.store';
import {
  MissingDetailsEmail,
  type MissingDetailsNoticeState,
  type RecentMissingDetailsEmail,
} from '../domain/missing-details-email';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const NOTICES: readonly string[] = ['pending', 'sent', 'skipped', 'failed'];
const PENDING_KEY = 'missing_details_emails_one_pending_key';

const EMAIL_SELECT = {
  id: true,
  marketId: true,
  sellerId: true,
  requestedByAccountId: true,
  requestedAt: true,
  subject: true,
  body: true,
  noticeState: true,
  noticeAttempts: true,
  noticeNextAttemptAt: true,
  sentAt: true,
  version: true,
  products: { select: { productId: true }, orderBy: { productId: 'asc' } },
} as const;

interface Row {
  readonly id: string;
  readonly marketId: string;
  readonly sellerId: string;
  readonly requestedByAccountId: string;
  readonly requestedAt: Date;
  readonly subject: string;
  readonly body: string;
  readonly noticeState: string;
  readonly noticeAttempts: number;
  readonly noticeNextAttemptAt: Date | null;
  readonly sentAt: Date | null;
  readonly version: number;
  readonly products: readonly { readonly productId: string }[];
}

/**
 * {@link MissingDetailsEmailStore} on `catalog.missing_details_emails` and
 * `catalog.missing_details_email_products` (attributes A4-4). Every statement goes through
 * `PrismaService.tx(market)` with `marketId` in `where`. The products of an email are read in id
 * order; the job sends the stored text, so their order there does not matter.
 */
export class PrismaMissingDetailsEmailStore implements MissingDetailsEmailStore {
  constructor(private readonly prisma: PrismaService) {}

  async add(market: MarketContext, email: MissingDetailsEmail): Promise<'email.pending' | null> {
    const state = email.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaMissingDetailsEmailStore: the email is of another Market');
    }
    const client = this.prisma.tx(market);
    try {
      await client.catalogMissingDetailsEmail.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: state.sellerId,
          requestedByAccountId: state.requestedByAccountId,
          requestedAt: toDate(state.requestedAt),
          subject: state.subject,
          body: state.text,
          noticeState: 'pending',
          noticeAttempts: 0,
          noticeNextAttemptAt:
            state.noticeNextAttemptAt === null ? null : toDate(state.noticeNextAttemptAt),
          sentAt: null,
          version: state.version,
        },
        select: { id: true },
      });
    } catch (error) {
      if (isPendingViolation(error)) return 'email.pending';
      throw error;
    }
    await client.catalogMissingDetailsEmailProduct.createMany({
      data: state.productIds.map((productId) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        emailId: state.id,
        productId,
      })),
    });
    return null;
  }

  async recent(
    market: MarketContext,
    productIds: readonly string[],
    since: Temporal.Instant,
  ): Promise<readonly RecentMissingDetailsEmail[]> {
    if (productIds.length === 0) return [];
    const rows = await this.prisma.tx(market).catalogMissingDetailsEmailProduct.findMany({
      where: {
        marketId: market.marketId,
        productId: { in: [...productIds] },
        email: {
          marketId: market.marketId,
          noticeState: { in: ['pending', 'sent'] },
          requestedAt: { gt: toDate(since) },
        },
      },
      select: {
        productId: true,
        email: { select: { sellerId: true, requestedAt: true, sentAt: true } },
      },
    });
    return rows.map((row) => ({
      sellerId: row.email.sellerId,
      productId: row.productId,
      requestedAt: toInstant(row.email.requestedAt),
      emailedAt: toInstant(row.email.sentAt ?? row.email.requestedAt),
    }));
  }

  async pendingSellers(
    market: MarketContext,
    sellerIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (sellerIds.length === 0) return new Set();
    const rows = await this.prisma.tx(market).catalogMissingDetailsEmail.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: [...sellerIds] },
        noticeState: 'pending',
      },
      select: { sellerId: true },
    });
    return new Set(rows.map((row) => row.sellerId));
  }

  async lastEmailed(
    market: MarketContext,
    productIds: readonly string[],
  ): Promise<ReadonlyMap<string, Temporal.Instant>> {
    const last = new Map<string, Temporal.Instant>();
    if (productIds.length === 0) return last;
    const rows = await this.prisma.tx(market).catalogMissingDetailsEmailProduct.findMany({
      where: {
        marketId: market.marketId,
        productId: { in: [...productIds] },
        email: { marketId: market.marketId, noticeState: 'sent' },
      },
      select: { productId: true, email: { select: { sentAt: true } } },
    });
    for (const row of rows) {
      if (row.email.sentAt === null) continue;
      const at = toInstant(row.email.sentAt);
      const known = last.get(row.productId);
      if (known === undefined || Temporal.Instant.compare(at, known) > 0)
        last.set(row.productId, at);
    }
    return last;
  }

  async dueNotices(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly MissingDetailsEmail[]> {
    const rows = await this.prisma.tx(market).catalogMissingDetailsEmail.findMany({
      where: {
        marketId: market.marketId,
        noticeState: 'pending',
        noticeNextAttemptAt: { lte: toDate(now) },
      },
      select: EMAIL_SELECT,
      orderBy: [{ noticeNextAttemptAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(emailOf);
  }

  async saveNotice(market: MarketContext, email: MissingDetailsEmail): Promise<void> {
    const state = email.state;
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaMissingDetailsEmailStore: the email is of another Market');
    }
    const { count } = await this.prisma.tx(market).catalogMissingDetailsEmail.updateMany({
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
        sentAt: state.sentAt === null ? null : toDate(state.sentAt),
        version: state.version,
      },
    });
    if (count !== 1) throw new StaleAggregateError('missing-details-email', state.id);
  }
}

function emailOf(row: Row): MissingDetailsEmail {
  if (!NOTICES.includes(row.noticeState)) {
    throw new Error(`PrismaMissingDetailsEmailStore: unknown notice state ${row.noticeState}`);
  }
  return MissingDetailsEmail.rehydrate({
    id: row.id as Id<'MissingDetailsEmail'>,
    marketId: row.marketId as MarketId,
    sellerId: row.sellerId as Id<'Seller'>,
    productIds: row.products.map((p) => p.productId as Id<'Product'>),
    requestedByAccountId: row.requestedByAccountId as Id<'Account'>,
    requestedAt: toInstant(row.requestedAt),
    subject: row.subject,
    text: row.body,
    noticeState: row.noticeState as MissingDetailsNoticeState,
    noticeAttempts: row.noticeAttempts,
    noticeNextAttemptAt:
      row.noticeNextAttemptAt === null ? null : toInstant(row.noticeNextAttemptAt),
    sentAt: row.sentAt === null ? null : toInstant(row.sentAt),
    version: row.version,
  });
}

/**
 * Whether a create failed on the one-pending index (the seller has a pending email). Prisma 7 with
 * the pg adapter names the index in the driver error's constraint, else in the PostgreSQL message.
 * Any other unique violation stays an error.
 */
function isPendingViolation(error: unknown): boolean {
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
  if (cause?.constraint?.index === PENDING_KEY) return true;
  const message = cause?.originalMessage;
  return typeof message === 'string' && message.includes(`"${PENDING_KEY}"`);
}
