import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ListingTags, OfferListingsReader } from '../application/ports/offer-listings.reader';
import {
  sellUnitKey,
  type OfferListingBadge,
  type OfferListing,
  type OfferListingTag,
  type OfferListingsMap,
  type SellUnitKey,
  type VariantAxisValue,
} from '../contracts/catalog.facade';
import { sellUnitDisplaySku } from '../domain/offer-sell-unit';
import { variantCodeOf } from '../domain/product';
import { readAxisValues } from './variant-axis-values';

export { asTexts, pick } from './locale-pick';
import { pick, asTexts } from './locale-pick';

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * The stored badge data as the facade's badge, field by field, or null when it does not have the
 * badge's shape or names another type (fail closed: never a badge built from a guess).
 */
function badgeOf(value: unknown, typeCode: string): OfferListingBadge | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const issuer = raw.issuer as Record<string, unknown> | null | undefined;
  if (
    raw.typeCode !== typeCode ||
    !isString(raw.typeRevisionId) ||
    (raw.basis !== 'SELLER' && raw.basis !== 'MANUFACTURER') ||
    typeof raw.sellerClaim !== 'boolean' ||
    (issuer !== null &&
      (typeof issuer !== 'object' || !isString(issuer.id) || !isString(issuer.displayName))) ||
    (raw.validUntilLocalDate !== null && !isString(raw.validUntilLocalDate)) ||
    (raw.validUntilZone !== null && !isString(raw.validUntilZone)) ||
    typeof raw.verifiedWithIssuer !== 'boolean' ||
    raw.reviewedByPlatform !== true
  ) {
    return null;
  }
  return {
    typeCode,
    typeRevisionId: raw.typeRevisionId as Id,
    basis: raw.basis,
    sellerClaim: raw.sellerClaim,
    issuer:
      issuer === null ? null : { id: issuer.id as Id, displayName: issuer.displayName as string },
    validUntilLocalDate: raw.validUntilLocalDate,
    validUntilZone: raw.validUntilZone,
    verifiedWithIssuer: raw.verifiedWithIssuer,
    reviewedByPlatform: true,
  };
}

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
    now: Temporal.Instant,
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
      select: { id: true, sellerId: true, productId: true, listed: true, sellerSku: true },
    });
    if (offers.length === 0) return result;
    const products = await tx.catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...new Set(offers.map((o) => o.productId))] },
        status: 'published',
        publishedRevisionId: { not: null },
      },
      select: { id: true, publishedRevisionId: true, productCode: true },
    });
    const revisionOf = new Map<string, string>();
    const codeOf = new Map<string, string>();
    for (const row of products) {
      if (row.publishedRevisionId !== null) revisionOf.set(row.id, row.publishedRevisionId);
      codeOf.set(row.id, row.productCode);
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
      select: { revisionId: true, variantId: true, labels: true, optionValues: true },
    });
    const axesOfRows = await readAxisValues(
      tx,
      market.marketId,
      revisionVariants.map((row) => row.optionValues),
      locales,
    );
    const axesOf = new Map<string, VariantAxisValue[]>();
    revisionVariants.forEach((row, index) => {
      axesOf.set(`${row.revisionId}:${row.variantId}`, axesOfRows[index]!);
    });
    const labelsOf = new Map<string, Record<string, string> | null>();
    for (const row of revisionVariants) {
      labelsOf.set(`${row.revisionId}:${row.variantId}`, asTexts(row.labels));
    }
    const publishedVariants = new Map(
      (
        await tx.catalogProductVariant.findMany({
          where: {
            marketId: market.marketId,
            productId: { in: [...revisionOf.keys()] },
            id: { in: variantIds },
            state: 'published',
          },
          select: { id: true, productId: true, variantNo: true },
        })
      ).map((row) => [`${row.productId}:${row.id}`, row.variantNo] as const),
    );
    const unitRows = await tx.catalogOfferSellUnit.findMany({
      where: {
        marketId: market.marketId,
        offerId: { in: listedOffers.map((offer) => offer.id) },
        variantId: { in: variantIds },
      },
      select: { offerId: true, variantId: true, variantSku: true, selling: true },
    });
    const unitOf = new Map(
      unitRows.map((row) => [`${row.offerId}:${row.variantId}`, row] as const),
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
    // The anonymous rule reads no tag at all (Hassan; kept after slice 12).
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
            select: {
              offerId: true,
              typeCode: true,
              status: true,
              basis: true,
              validUntil: true,
              badgeData: true,
            },
          });
    const tagsOf = new Map<string, OfferListingTag[]>();
    for (const row of tagRows) {
      const status = row.status as OfferListingTag['status'];
      const tag: OfferListingTag = {
        typeCode: row.typeCode,
        status,
        basis: row.basis as OfferListingTag['basis'],
        // Slice 12 (Hassan L-1): an `active` tag's badge copy, only while its copy is valid at
        // `now` and only when the stored data has the badge's shape (fail closed: no badge).
        badge:
          status === 'active' &&
          (row.validUntil === null || row.validUntil.getTime() > now.epochMilliseconds)
            ? badgeOf(row.badgeData, row.typeCode)
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
      const variantNo = publishedVariants.get(`${offer.productId}:${key.variantId}`);
      const names = namesOf.get(revisionId);
      result.set(sellUnitKey(key), {
        sellerId: offer.sellerId as Id<'Seller'>,
        productId: offer.productId as Id<'Product'>,
        publishedRevisionId: revisionId as Id<'ProductRevision'>,
        listed: offer.listed,
        variantBelongs: inRevision && publishedVariants.has(`${offer.productId}:${key.variantId}`),
        productName: names === undefined ? null : pick(names, locales),
        variantLabel: labels === null ? null : pick(labels, locales),
        variantNo: variantNo ?? null,
        variantCode:
          variantNo === undefined || !inRevision
            ? null
            : variantCodeOf(codeOf.get(offer.productId)!, variantNo),
        axes: inRevision ? (axesOf.get(`${revisionId}:${key.variantId}`) ?? []) : [],
        selling: unitOf.get(`${offer.id}:${key.variantId}`)?.selling ?? true,
        variantSku: unitOf.get(`${offer.id}:${key.variantId}`)?.variantSku ?? null,
        displaySku:
          variantNo === undefined || !inRevision
            ? null
            : sellUnitDisplaySku({
                sellerSku: offer.sellerSku,
                variantSku: unitOf.get(`${offer.id}:${key.variantId}`)?.variantSku ?? null,
                variantNo,
              }),
        primaryImageId: imageOf.get(revisionId) ?? null,
        tags: tagsOf.get(offer.id) ?? [],
      });
    }
    return result;
  }
}
