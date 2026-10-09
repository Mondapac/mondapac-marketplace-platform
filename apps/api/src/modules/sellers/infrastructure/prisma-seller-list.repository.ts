import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ListCounts,
  ListedSeller,
  ListPageQuery,
  SearchCandidates,
  SellerListRepository,
} from '../application/ports/seller-list.repository';
import { SELLER_FILE_ORIGINS } from '../domain/seller-file';
import { LIST_KINDS, type ListKind, type ListSearch } from '../domain/seller-list';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** The upper bound of a prefix range on a `COLLATE "C"` key (data design A6, A7). */
const PREFIX_END = '\u{10FFFF}';

/**
 * The clear columns of a file the list reads (Hassan M4): no ciphertext column is selected. The
 * saved address is only tested for presence (`addressPresence`, a `NOT NULL` filter that selects
 * the id), so `address_ciphertext` itself never leaves the database.
 */
const FILE_SELECT = {
  sellerId: true,
  origin: true,
  storeName: true,
  draftSlug: true,
  serviceAreaCode: true,
  operatingTimezone: true,
  draftComplete: true,
  approvedRevisionId: true,
  createdAt: true,
  lastChangedAt: true,
} as const;

type FileRow = Prisma.SellersSellerFileGetPayload<{ select: typeof FILE_SELECT }>;

interface PendingRow {
  readonly id: string;
  readonly sellerId: string;
  readonly kind: string;
  readonly revisionNo: number;
  readonly createdAt: Date;
}

function kindOf(value: string): ListKind {
  if (!(LIST_KINDS as readonly string[]).includes(value)) {
    throw new Error('sellers.business_file_revisions holds an invalid kind');
  }
  return value as ListKind;
}

function originOf(value: string): 'self' | 'invitation' {
  if (!(SELLER_FILE_ORIGINS as readonly string[]).includes(value)) {
    throw new Error('sellers.seller_files holds an invalid origin');
  }
  return value as 'self' | 'invitation';
}

/**
 * {@link SellerListRepository} on `sellers`' own tables (data design A3 to A8). Every statement
 * goes through `PrismaService.tx(market)` with `marketId` at the top level of `where`, selects
 * clear columns only, and reads in a bounded page (`take`), never a whole table. The slug of a
 * page is one more statement for its ids, and the pending submissions of a page one more: three
 * statements a page, whatever its length (no N+1).
 */
export class PrismaSellerListRepository implements SellerListRepository {
  constructor(private readonly prisma: PrismaService) {}

  async awaitingReview(
    market: MarketContext,
    query: ListPageQuery,
  ): Promise<readonly ListedSeller[]> {
    const tx = this.prisma.tx(market);
    const cursor = query.after?.tab === 'awaiting-review' ? query.after : null;
    const after = cursor === null ? null : toDate(cursor.createdAt);
    const where: Prisma.SellersBusinessFileRevisionWhereInput = {
      marketId: market.marketId,
      status: 'pending',
      ...(query.kind === null ? {} : { kind: query.kind }),
      ...(query.onlyIds === null ? {} : { sellerId: { in: [...query.onlyIds] } }),
      ...(cursor === null
        ? {}
        : {
            OR: [
              { createdAt: { gt: after! } },
              { createdAt: after!, id: { gt: cursor.revisionId } },
            ],
          }),
    };
    const revisions = await tx.sellersBusinessFileRevision.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.take,
      select: {
        id: true,
        sellerId: true,
        kind: true,
        revisionNo: true,
        createdAt: true,
        sellerFile: { select: FILE_SELECT },
      },
    });
    const addresses = await this.addressPresence(
      market,
      revisions.map((revision) => revision.sellerId),
    );
    const slugs = await this.heldSlugs(
      market,
      revisions.map((revision) => revision.sellerId),
    );
    return revisions.map((revision) =>
      listed(revision.sellerFile, {
        heldSlug: slugs.get(revision.sellerId) ?? null,
        hasAddress: addresses.has(revision.sellerId),
        pending: revision,
      }),
    );
  }

  async incomplete(market: MarketContext, query: ListPageQuery): Promise<readonly ListedSeller[]> {
    const cursor = query.after?.tab === 'incomplete' ? query.after : null;
    const changed = cursor === null ? null : toDate(cursor.changedAt);
    const and: Prisma.SellersSellerFileWhereInput[] = [];
    if (query.outsideArea) {
      and.push({
        addressCiphertext: { not: null },
        OR: [{ serviceAreaCode: null }, { serviceAreaCode: { notIn: [...query.openAreaCodes] } }],
      });
    }
    if (cursor !== null) {
      and.push({
        OR: [
          { lastChangedAt: { lt: changed! } },
          { lastChangedAt: changed!, sellerId: { lt: cursor.sellerId } },
        ],
      });
    }
    return this.files(
      market,
      {
        marketId: market.marketId,
        approvedRevisionId: null,
        draftComplete: false,
        revisions: { none: { marketId: market.marketId, status: 'pending' } },
        ...(query.onlyIds === null ? {} : { sellerId: { in: [...query.onlyIds] } }),
        ...(and.length === 0 ? {} : { AND: and }),
      },
      // Descending on both keys so the partial index (market_id, last_changed_at, seller_id)
      // WHERE approved_revision_id IS NULL is scanned backwards (data design A4).
      [{ lastChangedAt: 'desc' }, { sellerId: 'desc' }],
      query.take,
    );
  }

  async all(market: MarketContext, query: ListPageQuery): Promise<readonly ListedSeller[]> {
    const cursor = query.after?.tab === 'all' ? query.after : null;
    const bounds: Prisma.UuidFilter = {
      ...(query.onlyIds === null ? {} : { in: [...query.onlyIds] }),
      ...(cursor === null ? {} : { lt: cursor.sellerId }),
    };
    return this.files(
      market,
      {
        marketId: market.marketId,
        ...(Object.keys(bounds).length === 0 ? {} : { sellerId: bounds }),
      },
      // The seller id is a UUID v7: newest first, on the primary key.
      [{ sellerId: 'desc' }],
      query.take,
    );
  }

  async counts(market: MarketContext): Promise<ListCounts> {
    const tx = this.prisma.tx(market);
    const [pending, incomplete, all] = await Promise.all([
      tx.sellersBusinessFileRevision.groupBy({
        by: ['kind'],
        where: { marketId: market.marketId, status: 'pending' },
        _count: { _all: true },
      }),
      tx.sellersSellerFile.count({
        where: {
          marketId: market.marketId,
          approvedRevisionId: null,
          draftComplete: false,
          revisions: { none: { marketId: market.marketId, status: 'pending' } },
        },
      }),
      tx.sellersSellerFile.count({ where: { marketId: market.marketId } }),
    ]);
    const of = (kind: ListKind): number =>
      pending.find((group) => group.kind === kind)?._count._all ?? 0;
    return {
      awaitingReview: { onboarding: of('onboarding'), identityChange: of('identity-change') },
      incomplete,
      all,
    };
  }

  async searchCandidates(
    market: MarketContext,
    search: ListSearch,
    cap: number,
  ): Promise<SearchCandidates> {
    const tx = this.prisma.tx(market);
    const [byName, bySlug] = await Promise.all([
      tx.sellersSellerFile.findMany({
        where: {
          marketId: market.marketId,
          storeNameKey: { gte: search.nameKey, lt: search.nameKey + PREFIX_END },
        },
        orderBy: { storeNameKey: 'asc' },
        take: cap + 1,
        select: { sellerId: true },
      }),
      search.slug === null
        ? Promise.resolve([] as { sellerId: string }[])
        : tx.sellersShopSlug.findMany({
            where: {
              marketId: market.marketId,
              state: 'held',
              slug: { gte: search.slug, lt: search.slug + PREFIX_END },
            },
            orderBy: { slug: 'asc' },
            take: cap + 1,
            select: { sellerId: true },
          }),
    ]);
    const merged = new Set([...byName, ...bySlug].map((row) => row.sellerId as Id<'Seller'>));
    // A slug holder with no file in this Market (a purged file) is dropped by the page query,
    // which reads `seller_files` with the Market; the cap counts what the two indexes named.
    return {
      ids: [...merged].slice(0, cap),
      overflow: byName.length > cap || bySlug.length > cap || merged.size > cap,
    };
  }

  private async files(
    market: MarketContext,
    where: Prisma.SellersSellerFileWhereInput,
    orderBy: Prisma.SellersSellerFileOrderByWithRelationInput[],
    take: number,
  ): Promise<readonly ListedSeller[]> {
    const tx = this.prisma.tx(market);
    const rows = await tx.sellersSellerFile.findMany({
      where,
      orderBy,
      take,
      select: FILE_SELECT,
    });
    const sellerIds = rows.map((row) => row.sellerId);
    const [slugs, addresses, pending] = await Promise.all([
      this.heldSlugs(market, sellerIds),
      this.addressPresence(market, sellerIds),
      this.pendingOf(market, sellerIds),
    ]);
    return rows.map((row) =>
      listed(row, {
        heldSlug: slugs.get(row.sellerId) ?? null,
        hasAddress: addresses.has(row.sellerId),
        pending: pending.get(row.sellerId) ?? null,
      }),
    );
  }

  private async heldSlugs(
    market: MarketContext,
    sellerIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (sellerIds.length === 0) return new Map();
    const rows = await this.prisma.tx(market).sellersShopSlug.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] }, state: 'held' },
      select: { sellerId: true, slug: true },
    });
    return new Map(rows.map((row) => [row.sellerId, row.slug]));
  }

  /** The sellers of the ids that have an address saved: a presence test, never the value. */
  private async addressPresence(
    market: MarketContext,
    sellerIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (sellerIds.length === 0) return new Set();
    const rows = await this.prisma.tx(market).sellersSellerFile.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: [...sellerIds] },
        addressCiphertext: { not: null },
      },
      select: { sellerId: true },
    });
    return new Set(rows.map((row) => row.sellerId));
  }

  private async pendingOf(
    market: MarketContext,
    sellerIds: readonly string[],
  ): Promise<ReadonlyMap<string, PendingRow>> {
    if (sellerIds.length === 0) return new Map();
    const rows = await this.prisma.tx(market).sellersBusinessFileRevision.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] }, status: 'pending' },
      select: { id: true, sellerId: true, kind: true, revisionNo: true, createdAt: true },
    });
    return new Map(rows.map((row) => [row.sellerId, row]));
  }
}

function listed(
  file: FileRow,
  extra: {
    readonly heldSlug: string | null;
    readonly hasAddress: boolean;
    readonly pending: PendingRow | null;
  },
): ListedSeller {
  return {
    sellerId: file.sellerId as Id<'Seller'>,
    origin: originOf(file.origin),
    storeName: file.storeName,
    heldSlug: extra.heldSlug,
    draftSlug: file.draftSlug,
    serviceAreaCode: file.serviceAreaCode,
    operatingTimezone: file.operatingTimezone,
    draftComplete: file.draftComplete,
    hasApprovedRevision: file.approvedRevisionId !== null,
    hasAddress: extra.hasAddress,
    createdAt: toInstant(file.createdAt),
    lastChangedAt: toInstant(file.lastChangedAt),
    pending:
      extra.pending === null
        ? null
        : {
            revisionId: extra.pending.id as Id<'BusinessFileRevision'>,
            kind: kindOf(extra.pending.kind),
            revisionNo: extra.pending.revisionNo,
            submittedAt: toInstant(extra.pending.createdAt),
          },
  };
}
