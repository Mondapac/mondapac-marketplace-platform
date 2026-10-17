import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ListingTags, OfferListingsReader } from '../application/ports/offer-listings.reader';
import {
  sellUnitKey,
  type OfferListing,
  type OfferListingBadge,
  type OfferListingTag,
  type OfferListingsMap,
  type SellUnitKey,
} from '../contracts/catalog.facade';

/** The text for the requested locale, else the fallback, else the first locale in code order. */
function pick(
  texts: Readonly<Record<string, string>>,
  locales: { readonly requested: string; readonly fallback: string },
): string | null {
  if (typeof texts[locales.requested] === 'string') return texts[locales.requested]!;
  if (typeof texts[locales.fallback] === 'string') return texts[locales.fallback]!;
  const first = Object.keys(texts).sort()[0];
  return first === undefined ? null : texts[first]!;
}

const asTexts = (value: unknown): Record<string, string> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : null;

/**
 * {@link OfferListingsReader}: published Offers by `(market_id, id)`, their published products,
 * then the published revisions' texts, variants and first image, the variant registry and the
 * Offers' open tags. Up to seven statements, no join, every one scoped by `market_id`; the
 * tag read runs only for the `system` rule, so an anonymous caller's read never touches a tag.
 */
export class PrismaOfferListingsReader implements OfferListingsReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    keys: readonly SellUnitKey[],
    locales: { readonly requested: string; readonly fallback: string },
    tags: ListingTags,
  ): Promise<OfferListingsMap> {
    const result = new Map<string, OfferListing>();
    if (keys.length === 0) return result;
    const tx = this.prisma.tx(market);
    const offers = await tx.catalogOffer.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...new Set(keys.map((k) => k.offerId))] },
        status: 'published',
      },
      select: { id: true, sellerId: true, productId: true, listed: true },
    });
    if (offers.length === 0) return result;
    const products = await tx.catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...new Set(offers.map((o) => o.productId))] },
        status: 'published',
        publishedRevisionId: { not: null },
      },
      select: { id: true, publishedRevisionId: true },
    });
    const revisionOf = new Map<string, string>();
    for (const row of products) {
      if (row.publishedRevisionId !== null) revisionOf.set(row.id, row.publishedRevisionId);
    }
    const listedOffers = offers.filter((offer) => revisionOf.has(offer.productId));
    if (listedOffers.length === 0) return result;
    const revisionIds = [...new Set(revisionOf.values())];
    const variantIds = [...new Set(keys.map((k) => k.variantId))];

    const texts = await tx.catalogProductRevisionText.findMany({
      where: { marketId: market.marketId, revisionId: { in: revisionIds } },
      select: { revisionId: true, locale: true, name: true },
    });
    const namesOf = new Map<string, Record<string, string>>();
    for (const text of texts) {
      const byLocale = namesOf.get(text.revisionId) ?? {};
      byLocale[text.locale] = text.name;
      namesOf.set(text.revisionId, byLocale);
    }
    const revisionVariants = await tx.catalogProductRevisionVariant.findMany({
      where: {
        marketId: market.marketId,
        revisionId: { in: revisionIds },
        variantId: { in: variantIds },
      },
      select: { revisionId: true, variantId: true, labels: true },
    });
    const labelsOf = new Map<string, Record<string, string> | null>();
    for (const row of revisionVariants) {
      labelsOf.set(`${row.revisionId}:${row.variantId}`, asTexts(row.labels));
    }
    const publishedVariants = new Set(
      (
        await tx.catalogProductVariant.findMany({
          where: {
            marketId: market.marketId,
            productId: { in: [...revisionOf.keys()] },
            id: { in: variantIds },
            state: 'published',
          },
          select: { id: true, productId: true },
        })
      ).map((row) => `${row.productId}:${row.id}`),
    );
    const firstImages = await tx.catalogProductRevisionImage.findMany({
      where: { marketId: market.marketId, revisionId: { in: revisionIds }, position: 1 },
      select: { revisionId: true, imageId: true },
    });
    const cleanImages = new Set(
      firstImages.length === 0
        ? []
        : (
            await tx.catalogProductImage.findMany({
              where: {
                marketId: market.marketId,
                id: { in: firstImages.map((row) => row.imageId) },
                state: 'clean',
              },
              select: { id: true },
            })
          ).map((row) => row.id),
    );
    const imageOf = new Map(
      firstImages
        .filter((row) => cleanImages.has(row.imageId))
        .map((row) => [row.revisionId, row.imageId as Id]),
    );
    // The anonymous rule reads no tag at all (slice 12 brings the revoke and expiry consumers).
    const tagRows =
      tags === 'none'
        ? []
        : await tx.catalogOfferTag.findMany({
            where: {
              marketId: market.marketId,
              offerId: { in: listedOffers.map((offer) => offer.id) },
              status: { in: ['active', 'rechecking', 'suspended'] },
            },
            orderBy: [{ typeCode: 'asc' }],
            select: { offerId: true, typeCode: true, status: true, basis: true, badgeData: true },
          });
    const tagsOf = new Map<string, OfferListingTag[]>();
    for (const row of tagRows) {
      const status = row.status as OfferListingTag['status'];
      const tag: OfferListingTag = {
        typeCode: row.typeCode,
        status,
        basis: row.basis as OfferListingTag['basis'],
        // Badge data only while active (data design CHECK; design 5.3).
        badge:
          status === 'active' && row.badgeData !== null
            ? (row.badgeData as unknown as OfferListingBadge)
            : null,
      };
      tagsOf.set(row.offerId, [...(tagsOf.get(row.offerId) ?? []), tag]);
    }

    const offerById = new Map(listedOffers.map((offer) => [offer.id, offer]));
    for (const key of keys) {
      const offer = offerById.get(key.offerId);
      if (offer === undefined) continue;
      const revisionId = revisionOf.get(offer.productId)!;
      const inRevision = labelsOf.has(`${revisionId}:${key.variantId}`);
      const labels = labelsOf.get(`${revisionId}:${key.variantId}`) ?? null;
      const names = namesOf.get(revisionId);
      result.set(sellUnitKey(key), {
        sellerId: offer.sellerId as Id<'Seller'>,
        productId: offer.productId as Id<'Product'>,
        publishedRevisionId: revisionId as Id<'ProductRevision'>,
        listed: offer.listed,
        variantBelongs: inRevision && publishedVariants.has(`${offer.productId}:${key.variantId}`),
        productName: names === undefined ? null : pick(names, locales),
        variantLabel: labels === null ? null : pick(labels, locales),
        primaryImageId: imageOf.get(revisionId) ?? null,
        tags: tagsOf.get(offer.id) ?? [],
      });
    }
    return result;
  }
}
