import { Temporal } from '@mondapac/shared-kernel';
import type { Id, IdGenerator, MarketContext, MarketId } from '@mondapac/shared-kernel';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  OfferActor,
  OfferAddRefusal,
  OfferRepository,
} from '../application/ports/offer.repository';
import type { OwnOfferFinder } from '../application/ports/own-offer-finder';
import {
  Offer,
  OFF_SALE_CAUSES,
  type OffSaleCause,
  type OfferHandling,
  type OfferStatus,
} from '../domain/offer';
import type {
  OfferTagState,
  OfferTagStatus,
  TagBadge,
  TagBasis,
  TagEntryPath,
} from '../domain/offer-tag';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const orNull = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

const UNIQUE_ONE_PER_PRODUCT = 'offers_market_id_seller_id_product_id_open_key';
const UNIQUE_SKU = 'offers_market_id_seller_id_seller_sku_open_key';

type OfferRow = Prisma.CatalogOfferGetPayload<object>;
type TagRow = Prisma.CatalogOfferTagGetPayload<object>;

/** A stored tag row as the Offer's entity (data design 3.15). */
export function tagFromRow(row: TagRow): OfferTagState {
  const complete =
    row.basis !== null &&
    row.certificateKind !== null &&
    row.certificateId !== null &&
    row.certificateVersionId !== null &&
    row.typeRevisionId !== null;
  return {
    id: row.id as Id<'OfferTag'>,
    typeCode: row.typeCode,
    status: row.status as OfferTagStatus,
    copy: complete
      ? {
          basis: row.basis as TagBasis,
          certificateKind: row.certificateKind as 'seller' | 'manufacturer',
          certificateId: row.certificateId as Id,
          certificateVersionId: row.certificateVersionId as Id,
          issuerId: row.issuerId as Id | null,
          typeRevisionId: row.typeRevisionId as Id,
          policyRevisionId: row.policyRevisionId as Id | null,
          validUntil: orNull(row.validUntil),
        }
      : null,
    badge: row.badgeData === null ? null : (row.badgeData as unknown as TagBadge),
    copyRevisionId: row.copyRevisionId as Id<'ProductRevision'> | null,
    copyRevisionPublished: row.copyRevisionPublished,
    inputsHash: row.inputsHash === null ? null : Buffer.from(row.inputsHash).toString('hex'),
    lastReasonCode: row.lastReasonCode,
    lastChangeCause: row.lastChangeCause as TagEntryPath | null,
    evaluatedAt: toInstant(row.evaluatedAt),
    statusChangedAt: toInstant(row.statusChangedAt),
    changeSeq: row.changeSeq,
    removedAt: orNull(row.removedAt),
    removedByKind: row.removedByKind as 'seller' | 'system' | null,
    removedByAccountId: row.removedByAccountId as Id<'Account'> | null,
    createdAt: toInstant(row.createdAt),
  };
}

/** The columns of a tag that may change (data design 7: every column but the identity ones). */
function tagChange(tag: OfferTagState) {
  return {
    status: tag.status,
    basis: tag.copy?.basis ?? null,
    certificateKind: tag.copy?.certificateKind ?? null,
    certificateId: tag.copy?.certificateId ?? null,
    certificateVersionId: tag.copy?.certificateVersionId ?? null,
    issuerId: tag.copy?.issuerId ?? null,
    typeRevisionId: tag.copy?.typeRevisionId ?? null,
    policyRevisionId: tag.copy?.policyRevisionId ?? null,
    validUntil:
      tag.copy?.validUntil === null || tag.copy?.validUntil === undefined
        ? null
        : toDate(tag.copy.validUntil),
    badgeData: tag.badge === null ? Prisma.DbNull : ({ ...tag.badge } as Prisma.InputJsonObject),
    copyRevisionId: tag.copyRevisionId,
    copyRevisionPublished: tag.copyRevisionPublished,
    inputsHash:
      tag.inputsHash === null ? null : Uint8Array.from(Buffer.from(tag.inputsHash, 'hex')),
    lastReasonCode: tag.lastReasonCode,
    lastChangeCause: tag.lastChangeCause,
    evaluatedAt: toDate(tag.evaluatedAt),
    statusChangedAt: toDate(tag.statusChangedAt),
    changeSeq: tag.changeSeq,
    removedAt: tag.removedAt === null ? null : toDate(tag.removedAt),
    removedByKind: tag.removedByKind,
    removedByAccountId: tag.removedByAccountId,
  };
}

/**
 * A stored Offer row as the aggregate. Without `tags` the Offer is a read-only projection (a list
 * or queue row) that cannot be saved (I1); a write reads it through `findById`.
 */
export function offerFromRow(row: OfferRow, tags?: readonly TagRow[]): Offer {
  const flags: Record<OffSaleCause, boolean> = {
    'type-not-allowed': row.offSaleTypeNotAllowed,
    'product-retired': row.offSaleProductRetired,
    'product-not-listed': row.offSaleProductNotListed,
    'product-paused': row.offSaleProductPaused,
    'tag-suspended': row.offSaleTagSuspended,
    'description-claim-text': row.offSaleDescriptionClaimText,
  };
  return Offer.restore(
    {
      id: row.id as Id<'Offer'>,
      marketId: row.marketId as MarketId,
      sellerId: row.sellerId as Id<'Seller'>,
      productId: row.productId as Id<'Product'>,
      sellerSku: row.sellerSku,
      conditionCode: row.conditionCode,
      description: row.description as Record<string, string>,
      handling: row.handling as OfferHandling | null,
      attestationRecordedAt: orNull(row.attestationRecordedAt),
      attestationAccountId: row.attestationAccountId as Id<'Account'> | null,
      status: row.status as OfferStatus,
      offSaleCauses: OFF_SALE_CAUSES.filter((cause) => flags[cause]),
      listed: row.listed,
      submittedAt: orNull(row.submittedAt),
      firstPublishedAt: orNull(row.firstPublishedAt),
      deletedAt: orNull(row.deletedAt),
      version: row.version,
      createdAt: toInstant(row.createdAt),
    },
    tags?.map(tagFromRow),
  );
}

/** The causes as the six stored flags, in the order of {@link OFF_SALE_CAUSES}. */
const causeFlags = (causes: readonly OffSaleCause[]) => ({
  offSaleTypeNotAllowed: causes.includes('type-not-allowed'),
  offSaleProductRetired: causes.includes('product-retired'),
  offSaleProductNotListed: causes.includes('product-not-listed'),
  offSaleProductPaused: causes.includes('product-paused'),
  offSaleTagSuspended: causes.includes('tag-suspended'),
  offSaleDescriptionClaimText: causes.includes('description-claim-text'),
});

/**
 * {@link OfferRepository} on `catalog.offers` and `offer_history` (data design 3.13, 3.14). Every
 * statement goes through `PrismaService.tx(market)` with `marketId` at the top level of `where`.
 * The two partial uniques decide a creation race: their violation is answered, not thrown, and
 * the caller ends its unit with an error because the transaction is already aborted.
 */
export class PrismaOfferRepository implements OfferRepository, OwnOfferFinder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async add(
    market: MarketContext,
    offer: Offer,
    actor: OfferActor,
  ): Promise<OfferAddRefusal | null> {
    const state = offer.state;
    if (state.marketId !== market.marketId) throw new Error('add: the offer is of another Market');
    if (offer.persistedVersion !== null) throw new Error('add: the offer is already stored');
    const tx = this.prisma.tx(market);
    try {
      await tx.catalogOffer.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: state.sellerId,
          productId: state.productId,
          sellerSku: state.sellerSku,
          conditionCode: state.conditionCode,
          description: { ...state.description },
          handling: state.handling,
          attestationRecordedAt:
            state.attestationRecordedAt === null ? null : toDate(state.attestationRecordedAt),
          attestationAccountId: state.attestationAccountId,
          status: state.status,
          ...causeFlags(state.offSaleCauses),
          listed: state.listed,
          submittedAt: state.submittedAt === null ? null : toDate(state.submittedAt),
          firstPublishedAt: state.firstPublishedAt === null ? null : toDate(state.firstPublishedAt),
          deletedAt: state.deletedAt === null ? null : toDate(state.deletedAt),
          version: state.version,
          createdAt: toDate(state.createdAt),
        },
        select: { id: true },
      });
    } catch (error) {
      const unique = this.prisma.violatedConstraint(error);
      if (unique === UNIQUE_ONE_PER_PRODUCT) return 'offer.exists-for-product';
      if (unique === UNIQUE_SKU) return 'offer.sku-taken';
      throw error;
    }
    await tx.catalogOfferHistory.create({
      data: {
        id: this.ids.next<'OfferHistory'>(),
        marketId: market.marketId,
        tenantId: market.tenantId,
        offerId: state.id,
        offerVersion: state.version,
        changeKind: 'created',
        changedFields: [],
        productId: state.productId,
        status: state.status,
        sellerSku: state.sellerSku,
        conditionCode: state.conditionCode,
        description: { ...state.description },
        handling: state.handling,
        attestationRecorded: state.attestationRecordedAt !== null,
        shelfCategoryId: null,
        listed: state.listed,
        offSaleCauses: [...state.offSaleCauses],
        actorKind: actor.kind,
        actorAccountId: actor.accountId,
        actingAdminAccountId: actor.actingAdminAccountId ?? null,
        occurredAt: toDate(state.createdAt),
      },
      select: { id: true },
    });
    return null;
  }

  async save(
    market: MarketContext,
    offer: Offer,
    actor: OfferActor,
  ): Promise<'offer.sku-taken' | null> {
    const state = offer.state;
    const expected = offer.persistedVersion;
    const history = offer.pendingHistory;
    if (expected === null) throw new Error('save: the offer was never stored; use add');
    if (state.marketId !== market.marketId) throw new Error('save: the offer is of another Market');
    if (!offer.tagsLoaded) throw new Error('save: the offer was read without its tags');
    if (!offer.hasChanges) return null;
    const tx = this.prisma.tx(market);
    try {
      const { count } = await tx.catalogOffer.updateMany({
        where: { marketId: market.marketId, id: state.id, version: expected },
        data: {
          sellerSku: state.sellerSku,
          conditionCode: state.conditionCode,
          description: { ...state.description },
          handling: state.handling,
          // Written only by `recordAttestation` (B1); both or neither (offers_attestation_check).
          attestationRecordedAt:
            state.attestationRecordedAt === null ? null : toDate(state.attestationRecordedAt),
          attestationAccountId: state.attestationAccountId,
          status: state.status,
          ...causeFlags(state.offSaleCauses),
          listed: state.listed,
          submittedAt: state.submittedAt === null ? null : toDate(state.submittedAt),
          firstPublishedAt: state.firstPublishedAt === null ? null : toDate(state.firstPublishedAt),
          deletedAt: state.deletedAt === null ? null : toDate(state.deletedAt),
          version: state.version,
        },
      });
      if (count !== 1) throw new StaleAggregateError('offer', state.id);
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === UNIQUE_SKU) return 'offer.sku-taken';
      throw error;
    }
    if (history !== null) {
      await tx.catalogOfferHistory.create({
        data: {
          id: this.ids.next<'OfferHistory'>(),
          marketId: market.marketId,
          tenantId: market.tenantId,
          offerId: state.id,
          offerVersion: state.version,
          changeKind: history.changeKind,
          changedFields: [...history.changedFields],
          productId: state.productId,
          status: state.status,
          sellerSku: state.sellerSku,
          conditionCode: state.conditionCode,
          description: { ...state.description },
          handling: state.handling,
          attestationRecorded: state.attestationRecordedAt !== null,
          shelfCategoryId: null,
          listed: state.listed,
          offSaleCauses: [...state.offSaleCauses],
          actorKind: actor.kind,
          actorAccountId: actor.accountId,
          actingAdminAccountId: actor.actingAdminAccountId ?? null,
          occurredAt: toDate(history.occurredAt),
        },
        select: { id: true },
      });
    }
    await this.#saveTags(market, offer, actor);
    return null;
  }

  /**
   * The tag rows the Offer added or changed, then their history rows (data design 3.15, 3.16).
   * Each update is conditional on the `change_seq` the tag had when read (Mojtaba F2): a tag
   * changed by another unit since answers `StaleAggregateError` and the command asks again. The
   * deferred trigger checks at commit that every change of status or copy has its history row.
   */
  async #saveTags(market: MarketContext, offer: Offer, actor: OfferActor): Promise<void> {
    const { added, changed } = offer.pendingTagChanges;
    if (added.length === 0 && changed.length === 0) return;
    const tx = this.prisma.tx(market);
    const state = offer.state;
    const byId = new Map(offer.tags.map((tag) => [tag.id as string, tag]));
    for (const id of added) {
      const tag = byId.get(id)!;
      await tx.catalogOfferTag.create({
        data: {
          id: tag.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          offerId: state.id,
          sellerId: state.sellerId,
          typeCode: tag.typeCode,
          ...tagChange(tag),
          createdAt: toDate(tag.createdAt),
        },
        select: { id: true },
      });
    }
    for (const id of changed) {
      const tag = byId.get(id)!;
      const readSeq = offer.readChangeSeqOf(tag.id);
      if (readSeq === undefined) throw new Error('save: a changed tag that was never read');
      const { count } = await tx.catalogOfferTag.updateMany({
        where: { marketId: market.marketId, id: tag.id, offerId: state.id, changeSeq: readSeq },
        data: tagChange(tag),
      });
      if (count !== 1) throw new StaleAggregateError('offer', state.id);
    }
    for (const row of offer.pendingTagHistory) {
      await tx.catalogOfferTagHistory.create({
        data: {
          id: this.ids.next<'OfferTagHistory'>(),
          marketId: market.marketId,
          tenantId: market.tenantId,
          tagId: row.tagId,
          offerId: state.id,
          typeCode: row.typeCode,
          fromStatus: row.fromStatus,
          toStatus: row.toStatus,
          basis: row.copy?.basis ?? null,
          certificateKind: row.copy?.certificateKind ?? null,
          certificateId: row.copy?.certificateId ?? null,
          certificateVersionId: row.copy?.certificateVersionId ?? null,
          issuerId: row.copy?.issuerId ?? null,
          typeRevisionId: row.copy?.typeRevisionId ?? null,
          policyRevisionId: row.copy?.policyRevisionId ?? null,
          validUntil:
            row.copy?.validUntil === null || row.copy?.validUntil === undefined
              ? null
              : toDate(row.copy.validUntil),
          copyRevisionId: row.copyRevisionId,
          reasonCode: row.reasonCode,
          entryPath: row.entryPath,
          changeSeq: row.changeSeq,
          causeEventId: row.causeEventId,
          actorKind: row.actor.kind,
          actorAccountId: row.actor.accountId,
          actingAdminAccountId:
            row.actor.kind === 'seller' ? (actor.actingAdminAccountId ?? null) : null,
          occurredAt: toDate(row.occurredAt),
        },
        select: { id: true },
      });
    }
  }

  async listPendingReview(
    market: MarketContext,
    page: {
      readonly after: { readonly submittedAt: Temporal.Instant; readonly id: string } | null;
      readonly limit: number;
    },
  ): Promise<readonly Offer[]> {
    const tx = this.prisma.tx(market);
    const where = { marketId: market.marketId, status: 'pending-first-publish' } as const;
    const cursor = page.after;
    const after =
      cursor === null
        ? {}
        : {
            OR: [
              { submittedAt: { gt: toDate(cursor.submittedAt) } },
              { submittedAt: toDate(cursor.submittedAt), id: { gt: cursor.id } },
            ],
          };
    const rows = await tx.catalogOffer.findMany({
      where: { ...where, ...after },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: page.limit,
    });
    // A read-only projection for the review queue (no tags): never saved; a decision re-reads.
    return rows.map((row) => offerFromRow(row));
  }

  async findOwnOnProduct(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    productId: Id<'Product'>,
  ): Promise<Offer | null> {
    // The one-Offer partial unique serves this read (`status <> 'deleted'`, OFR-02).
    const row = await this.prisma.tx(market).catalogOffer.findFirst({
      where: { marketId: market.marketId, sellerId, productId, status: { not: 'deleted' } },
      select: { id: true },
    });
    return row === null ? null : this.findById(market, row.id as Id<'Offer'>);
  }

  async listOnProduct(
    market: MarketContext,
    productId: Id<'Product'>,
    page: { readonly afterId: Id<'Offer'> | null; readonly limit: number },
  ): Promise<readonly Offer[]> {
    const tx = this.prisma.tx(market);
    // Served by `offers_market_id_product_id_open_idx` (status <> 'deleted').
    const rows = await tx.catalogOffer.findMany({
      where: {
        marketId: market.marketId,
        productId,
        status: { not: 'deleted' },
        ...(page.afterId === null ? {} : { id: { gt: page.afterId } }),
      },
      orderBy: { id: 'asc' },
      take: page.limit,
    });
    if (rows.length === 0) return [];
    const tags = await tx.catalogOfferTag.findMany({
      where: {
        marketId: market.marketId,
        offerId: { in: rows.map((row) => row.id) },
        status: { not: 'removed' },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) =>
      offerFromRow(
        row,
        tags.filter((tag) => tag.offerId === row.id),
      ),
    );
  }

  async findManyByIds(
    market: MarketContext,
    ids: readonly Id<'Offer'>[],
  ): Promise<readonly Offer[]> {
    if (ids.length === 0) return [];
    const tx = this.prisma.tx(market);
    const rows = await tx.catalogOffer.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
      orderBy: { id: 'asc' },
    });
    if (rows.length === 0) return [];
    // The open tags only; served by the open-tag partial unique.
    const tags = await tx.catalogOfferTag.findMany({
      where: {
        marketId: market.marketId,
        offerId: { in: rows.map((row) => row.id) },
        status: { not: 'removed' },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) =>
      offerFromRow(
        row,
        tags.filter((tag) => tag.offerId === row.id),
      ),
    );
  }

  async findById(market: MarketContext, id: Id<'Offer'>): Promise<Offer | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.catalogOffer.findFirst({ where: { marketId: market.marketId, id } });
    if (row === null) return null;
    // The open tags only (a removed tag is history); served by the open-tag partial unique.
    const tags = await tx.catalogOfferTag.findMany({
      where: { marketId: market.marketId, offerId: id, status: { not: 'removed' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return offerFromRow(row, tags);
  }
}
