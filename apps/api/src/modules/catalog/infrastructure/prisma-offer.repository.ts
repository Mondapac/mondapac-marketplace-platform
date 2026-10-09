import { Temporal } from '@mondapac/shared-kernel';
import type { Id, IdGenerator, MarketContext, MarketId } from '@mondapac/shared-kernel';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  OfferActor,
  OfferAddRefusal,
  OfferRepository,
} from '../application/ports/offer.repository';
import {
  Offer,
  OFF_SALE_CAUSES,
  type OffSaleCause,
  type OfferHandling,
  type OfferStatus,
} from '../domain/offer';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const orNull = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

const UNIQUE_ONE_PER_PRODUCT = 'offers_market_id_seller_id_product_id_open_key';
const UNIQUE_SKU = 'offers_market_id_seller_id_seller_sku_open_key';

/** The causes as the five stored flags, in the order of {@link OFF_SALE_CAUSES}. */
const causeFlags = (causes: readonly OffSaleCause[]) => ({
  offSaleTypeNotAllowed: causes.includes('type-not-allowed'),
  offSaleProductRetired: causes.includes('product-retired'),
  offSaleProductNotListed: causes.includes('product-not-listed'),
  offSaleTagSuspended: causes.includes('tag-suspended'),
  offSaleDescriptionClaimText: causes.includes('description-claim-text'),
});

/**
 * {@link OfferRepository} on `catalog.offers` and `offer_history` (data design 3.13, 3.14). Every
 * statement goes through `PrismaService.tx(market)` with `marketId` at the top level of `where`.
 * The two partial uniques decide a creation race: their violation is answered, not thrown, and
 * the caller ends its unit with an error because the transaction is already aborted.
 */
export class PrismaOfferRepository implements OfferRepository {
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
    if (history === null) return null;
    const tx = this.prisma.tx(market);
    try {
      const { count } = await tx.catalogOffer.updateMany({
        where: { marketId: market.marketId, id: state.id, version: expected },
        data: {
          sellerSku: state.sellerSku,
          conditionCode: state.conditionCode,
          description: { ...state.description },
          status: state.status,
          submittedAt: state.submittedAt === null ? null : toDate(state.submittedAt),
          version: state.version,
        },
      });
      if (count !== 1) throw new StaleAggregateError('offer', state.id);
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === UNIQUE_SKU) return 'offer.sku-taken';
      throw error;
    }
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
    return null;
  }

  async findById(market: MarketContext, id: Id<'Offer'>): Promise<Offer | null> {
    const row = await this.prisma.tx(market).catalogOffer.findFirst({
      where: { marketId: market.marketId, id },
    });
    if (row === null) return null;
    const flags: Record<OffSaleCause, boolean> = {
      'type-not-allowed': row.offSaleTypeNotAllowed,
      'product-retired': row.offSaleProductRetired,
      'product-not-listed': row.offSaleProductNotListed,
      'tag-suspended': row.offSaleTagSuspended,
      'description-claim-text': row.offSaleDescriptionClaimText,
    };
    return Offer.restore({
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
    });
  }
}
