import { Temporal } from '@mondapac/shared-kernel';
import type { Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  NewCategoryProposal,
  NewShelf,
  ProposalDecision,
  SellerCategoryStore,
  ShelfActor,
} from '../application/ports/seller-category.store';
import type {
  CategoryProposalView,
  ProposalCancelReason,
  ProposalStatus,
  ShelfStatus,
  ShelfText,
  ShelfView,
} from '../domain/seller-category';
import { offerFromRow } from './prisma-offer.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const PENDING_KEY = 'category_proposals_pending_name_key';

interface ProposalRow {
  readonly id: string;
  readonly sellerId: string;
  readonly platformParentId: string;
  readonly names: unknown;
  readonly descriptions: unknown;
  readonly status: string;
  readonly reasonCode: string | null;
  readonly createdSellerCategoryId: string | null;
  readonly decidedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
}

const asRecord = (value: unknown): Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};

function proposalOf(row: ProposalRow): CategoryProposalView {
  const names = asRecord(row.names);
  const descriptions = asRecord(row.descriptions);
  return {
    id: row.id as Id<'CategoryProposal'>,
    sellerId: row.sellerId as Id<'Seller'>,
    platformParentId: row.platformParentId as Id<'Category'>,
    texts: Object.keys(names)
      .sort()
      .map((locale) => ({
        locale,
        name: names[locale]!,
        description: descriptions[locale] ?? null,
      })),
    status: row.status as ProposalStatus,
    reasonCode: row.reasonCode,
    createdSellerCategoryId: row.createdSellerCategoryId as Id<'SellerCategory'> | null,
    decidedAt: row.decidedAt === null ? null : toInstant(row.decidedAt),
    version: row.version,
    createdAt: toInstant(row.createdAt),
  };
}

const SHELF_ORDER: Readonly<Record<string, number>> = {
  active: 0,
  promoted: 1,
  merged: 2,
  archived: 3,
};

/**
 * {@link SellerCategoryStore} on `catalog.category_proposals`, `seller_categories`,
 * `seller_category_names` and the shelf column of `offers` (data design 3.22, 3.13, 3.14). Every
 * statement goes through `PrismaService.tx(market)` with `marketId` at the top level of `where`;
 * the guard triggers refuse any change the grants allow but the lifecycle does not.
 */
export class PrismaSellerCategoryStore implements SellerCategoryStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async addProposal(
    market: MarketContext,
    proposal: NewCategoryProposal,
  ): Promise<'proposal.duplicate' | null> {
    const names: Record<string, string> = {};
    const descriptions: Record<string, string> = {};
    for (const text of proposal.texts) {
      names[text.locale] = text.name;
      if (text.description !== null) descriptions[text.locale] = text.description;
    }
    try {
      await this.prisma.tx(market).catalogCategoryProposal.create({
        data: {
          id: proposal.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: proposal.sellerId,
          platformParentId: proposal.platformParentId,
          names,
          descriptions: Object.keys(descriptions).length > 0 ? descriptions : undefined,
          normalisedName: proposal.normalisedName,
          status: 'pending',
          version: 1,
          createdAt: toDate(proposal.now),
        },
        select: { id: true },
      });
      return null;
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === PENDING_KEY) return 'proposal.duplicate';
      throw error;
    }
  }

  async lockSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<void> {
    await this.prisma.namedQuery(market, 'catalog.lock-seller-shelves', { sellerId });
  }

  pendingCount(market: MarketContext, sellerId: Id<'Seller'>): Promise<number> {
    return this.prisma.tx(market).catalogCategoryProposal.count({
      where: { marketId: market.marketId, sellerId, status: 'pending' },
    });
  }

  async activeShelfNamed(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    platformParentId: Id<'Category'>,
    normalisedName: string,
  ): Promise<boolean> {
    const found = await this.prisma.tx(market).catalogCategoryProposal.findFirst({
      where: {
        marketId: market.marketId,
        sellerId,
        platformParentId,
        normalisedName,
        status: 'approved',
        createdSellerCategory: { is: { status: 'active' } },
      },
      select: { id: true },
    });
    return found !== null;
  }

  async findProposal(
    market: MarketContext,
    id: Id<'CategoryProposal'>,
  ): Promise<CategoryProposalView | null> {
    const row = await this.prisma.tx(market).catalogCategoryProposal.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : proposalOf(row);
  }

  async decideProposal(
    market: MarketContext,
    id: Id<'CategoryProposal'>,
    expectedVersion: number,
    decision: ProposalDecision,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogCategoryProposal.updateMany({
      where: { marketId: market.marketId, id, status: 'pending', version: expectedVersion },
      data: {
        status: decision.status,
        reasonCode: decision.status === 'approved' ? null : decision.reason,
        decidedByAccountId: decision.status === 'cancelled' ? null : decision.by,
        decidedAt: toDate(now),
        createdSellerCategoryId: decision.status === 'approved' ? decision.shelfId : null,
        version: expectedVersion + 1,
      },
    });
    return count === 1;
  }

  async cancelPendingOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    reason: ProposalCancelReason,
    now: Temporal.Instant,
  ): Promise<readonly { readonly id: Id<'CategoryProposal'>; readonly version: number }[]> {
    const tx = this.prisma.tx(market);
    const pending = await tx.catalogCategoryProposal.findMany({
      where: { marketId: market.marketId, sellerId, status: 'pending' },
      select: { id: true, version: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const cancelled: { id: Id<'CategoryProposal'>; version: number }[] = [];
    for (const row of pending) {
      const done = await this.decideProposal(
        market,
        row.id as Id<'CategoryProposal'>,
        row.version,
        { status: 'cancelled', reason },
        now,
      );
      if (done) cancelled.push({ id: row.id as Id<'CategoryProposal'>, version: row.version + 1 });
    }
    return cancelled;
  }

  async listPending(
    market: MarketContext,
    page: { readonly after: Id<'CategoryProposal'> | null; readonly limit: number },
  ): Promise<readonly CategoryProposalView[]> {
    const tx = this.prisma.tx(market);
    let after: { createdAt: Date; id: string } | null = null;
    if (page.after !== null) {
      // Any status: created_at and id never change, so a proposal decided since the last page is
      // still a valid position (Mojtaba N1).
      after = await tx.catalogCategoryProposal.findFirst({
        where: { marketId: market.marketId, id: page.after },
        select: { createdAt: true, id: true },
      });
      if (after === null) return [];
    }
    const rows = await tx.catalogCategoryProposal.findMany({
      where: {
        marketId: market.marketId,
        status: 'pending',
        ...(after === null
          ? {}
          : {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: page.limit,
    });
    return rows.map(proposalOf);
  }

  async listOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    limit: number,
  ): Promise<readonly CategoryProposalView[]> {
    const rows = await this.prisma.tx(market).catalogCategoryProposal.findMany({
      where: { marketId: market.marketId, sellerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(proposalOf);
  }

  async slugTaken(market: MarketContext, sellerId: Id<'Seller'>, slug: string): Promise<boolean> {
    const row = await this.prisma.tx(market).catalogSellerCategory.findFirst({
      where: { marketId: market.marketId, sellerId, slug },
      select: { id: true },
    });
    return row !== null;
  }

  async insertShelf(market: MarketContext, shelf: NewShelf): Promise<void> {
    const tx = this.prisma.tx(market);
    await tx.catalogSellerCategory.create({
      data: {
        id: shelf.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId: shelf.sellerId,
        platformParentId: shelf.platformParentId,
        slug: shelf.slug,
        status: 'active',
        mergedIntoId: null,
        version: 1,
        createdAt: toDate(shelf.now),
      },
      select: { id: true },
    });
    await tx.catalogSellerCategoryName.createMany({
      data: shelf.texts.map((text) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        categoryId: shelf.id,
        locale: text.locale,
        name: text.name,
        description: text.description,
      })),
    });
  }

  async findShelf(market: MarketContext, id: Id<'SellerCategory'>): Promise<ShelfView | null> {
    const row = await this.prisma.tx(market).catalogSellerCategory.findFirst({
      where: { marketId: market.marketId, id },
      include: { names: { where: { marketId: market.marketId }, orderBy: { locale: 'asc' } } },
    });
    return row === null ? null : shelfOf(row);
  }

  async shelvesOfSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<readonly ShelfView[]> {
    const rows = await this.prisma.tx(market).catalogSellerCategory.findMany({
      where: { marketId: market.marketId, sellerId },
      include: { names: { where: { marketId: market.marketId }, orderBy: { locale: 'asc' } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return rows
      .map(shelfOf)
      .sort((a, b) => (SHELF_ORDER[a.status] ?? 9) - (SHELF_ORDER[b.status] ?? 9));
  }

  async closeShelf(
    market: MarketContext,
    id: Id<'SellerCategory'>,
    expectedVersion: number,
    close:
      | { readonly status: 'promoted' }
      | { readonly status: 'merged'; readonly into: Id<'Category'> },
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogSellerCategory.updateMany({
      where: { marketId: market.marketId, id, status: 'active', version: expectedVersion },
      data: {
        status: close.status,
        mergedIntoId: close.status === 'merged' ? close.into : null,
        version: expectedVersion + 1,
      },
    });
    return count === 1;
  }

  async clearShelfOnOffers(
    market: MarketContext,
    shelfId: Id<'SellerCategory'>,
    actor: ShelfActor,
    now: Temporal.Instant,
  ): Promise<number> {
    // The caller holds the seller's shelf lock, so no Offer joins the shelf meanwhile. One
    // set-based update without a version predicate: an Offer edited in between still loses the
    // shelf (its editor gets `conflict.stale`), never kept on a closed one (Mojtaba B2). Then one
    // read of the changed rows and one insert of their history rows.
    const tx = this.prisma.tx(market);
    const carrying = await tx.catalogOffer.findMany({
      where: { marketId: market.marketId, shelfCategoryId: shelfId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let cleared = 0;
    // In batches, so a very large shelf stays far below PostgreSQL's bind-parameter limit.
    for (let start = 0; start < carrying.length; start += CLEAR_BATCH) {
      const ids = carrying.slice(start, start + CLEAR_BATCH).map((offer) => offer.id);
      await tx.catalogOffer.updateMany({
        where: { marketId: market.marketId, id: { in: ids }, shelfCategoryId: shelfId },
        data: { shelfCategoryId: null, version: { increment: 1 } },
      });
      const rows = await tx.catalogOffer.findMany({
        where: { marketId: market.marketId, id: { in: ids } },
        orderBy: { id: 'asc' },
      });
      await tx.catalogOfferHistory.createMany({
        data: rows.map((row) => this.#historyRow(market, row, 'shelf-cleared', [], actor, now)),
      });
      cleared += rows.length;
    }
    return cleared;
  }

  async setOfferShelf(
    market: MarketContext,
    change: {
      readonly offerId: Id<'Offer'>;
      readonly sellerId: Id<'Seller'>;
      readonly shelfId: Id<'SellerCategory'> | null;
      readonly expectedVersion: number;
      readonly actor: ShelfActor;
      readonly now: Temporal.Instant;
    },
  ): Promise<{ readonly version: number } | 'offer.not-found' | 'conflict.stale'> {
    const tx = this.prisma.tx(market);
    const current = await tx.catalogOffer.findFirst({
      where: {
        marketId: market.marketId,
        id: change.offerId,
        sellerId: change.sellerId,
        status: { not: 'deleted' },
      },
      select: { version: true },
    });
    if (current === null) return 'offer.not-found';
    if (current.version !== change.expectedVersion) return 'conflict.stale';
    const { count } = await tx.catalogOffer.updateMany({
      where: {
        marketId: market.marketId,
        id: change.offerId,
        sellerId: change.sellerId,
        version: change.expectedVersion,
      },
      data: { shelfCategoryId: change.shelfId, version: change.expectedVersion + 1 },
    });
    if (count !== 1) return 'conflict.stale';
    await this.#history(
      market,
      change.offerId,
      change.shelfId === null ? 'shelf-cleared' : 'edited',
      change.shelfId === null ? [] : ['shelf'],
      change.actor,
      change.now,
    );
    return { version: change.expectedVersion + 1 };
  }

  async platformParentState(
    market: MarketContext,
    id: Id<'Category'>,
  ): Promise<{ readonly status: string } | null> {
    return this.prisma.tx(market).catalogPlatformCategory.findFirst({
      where: { marketId: market.marketId, id },
      select: { status: true },
    });
  }

  /** The `offer_history` row of a shelf change: a snapshot of the Offer after it (D 3.14). */
  async #history(
    market: MarketContext,
    offerId: Id<'Offer'>,
    changeKind: 'edited' | 'shelf-cleared',
    changedFields: readonly string[],
    actor: ShelfActor,
    now: Temporal.Instant,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const row = await tx.catalogOffer.findFirst({
      where: { marketId: market.marketId, id: offerId },
    });
    if (row === null) throw new Error('PrismaSellerCategoryStore: the Offer vanished in the unit');
    await tx.catalogOfferHistory.create({
      data: this.#historyRow(market, row, changeKind, changedFields, actor, now),
      select: { id: true },
    });
  }

  /** The history row of an Offer row as it now stands. */
  #historyRow(
    market: MarketContext,
    row: Parameters<typeof offerFromRow>[0],
    changeKind: 'edited' | 'shelf-cleared',
    changedFields: readonly string[],
    actor: ShelfActor,
    now: Temporal.Instant,
  ) {
    const state = offerFromRow(row).state;
    return {
      id: this.ids.next<'OfferHistory'>(),
      marketId: market.marketId,
      tenantId: market.tenantId,
      offerId: row.id,
      offerVersion: state.version,
      changeKind,
      changedFields: [...changedFields],
      productId: state.productId,
      status: state.status,
      sellerSku: state.sellerSku,
      conditionCode: state.conditionCode,
      description: { ...state.description },
      handling: state.handling,
      attestationRecorded: state.attestationRecordedAt !== null,
      shelfCategoryId: row.shelfCategoryId,
      listed: state.listed,
      offSaleCauses: [...state.offSaleCauses],
      actorKind: actor.kind,
      actorAccountId: actor.accountId,
      actingAdminAccountId: actor.actingAdminAccountId,
      occurredAt: toDate(now),
    };
  }
}

/** Offers cleared per statement when a shelf closes. */
const CLEAR_BATCH = 1000;

interface ShelfRow {
  readonly id: string;
  readonly sellerId: string;
  readonly platformParentId: string;
  readonly slug: string;
  readonly status: string;
  readonly mergedIntoId: string | null;
  readonly version: number;
  readonly names: readonly { locale: string; name: string; description: string | null }[];
}

function shelfOf(row: ShelfRow): ShelfView {
  const texts: ShelfText[] = row.names.map(({ locale, name, description }) => ({
    locale,
    name,
    description,
  }));
  return {
    id: row.id as Id<'SellerCategory'>,
    sellerId: row.sellerId as Id<'Seller'>,
    platformParentId: row.platformParentId as Id<'Category'>,
    slug: row.slug,
    status: row.status as ShelfStatus,
    mergedIntoId: row.mergedIntoId as Id<'Category'> | null,
    texts,
    version: row.version,
  };
}
