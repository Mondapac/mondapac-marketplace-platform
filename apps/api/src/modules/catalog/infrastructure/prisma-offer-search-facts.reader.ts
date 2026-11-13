import { createHash } from 'node:crypto';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  MarketTransaction,
  PrismaService,
} from '../../../platform/persistence/prisma.service';
import type { OfferSearchFactsReader } from '../application/ports/offer-search-facts.reader';
import type {
  OfferSearchAttributes,
  OfferSearchFacts,
  OfferSearchFactsMap,
  OfferSearchVariant,
  PublishedOfferIdsInput,
} from '../contracts/catalog-index.facade';
import {
  buildSearchAttributes,
  buildVariantFacets,
  MAX_INDEXED_VARIANTS,
  NO_SEARCH_ATTRIBUTES,
  variantLabelOf,
  withVariantWords,
  type SearchBrand,
} from '../domain/search-attributes';
import { loadSearchDefinitions } from './search-definitions.loader';

/**
 * {@link OfferSearchFactsReader}: the Offers by `(market_id, id)`, then the published revisions
 * of their products, then the texts and categories of those revisions, each its own statement, no
 * join.
 * An Offer whose product has no published revision, or no text in the asked locale, has
 * `text: null`. The attributes (A7) come from the revisions' attribute values, the product's
 * ACTIVE brand with its aliases (brands are shared by every Market) and the PUBLISHED revisions
 * of the definitions the values name. The variants (V8) are the published revision's variants whose
 * registry state is `published`, with their axis facets, label and GTIN; their labels are added to
 * the search text. A variant the seller switched off for an Offer (V5 `selling = false`) is left out
 * of that Offer's variants, so it gives no facet, price, label word or GTIN match.
 */
export class PrismaOfferSearchFactsReader implements OfferSearchFactsReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<OfferSearchFactsMap> {
    const result = new Map<Id<'Offer'>, OfferSearchFacts>();
    if (offerIds.length === 0) return result;
    const tx = this.prisma.tx(market);
    const offers = await tx.catalogOffer.findMany({
      where: { marketId: market.marketId, id: { in: [...offerIds] } },
      select: { id: true, sellerId: true, productId: true, status: true, listed: true },
    });
    const productIds = [...new Set(offers.map((offer) => offer.productId))];
    const products =
      productIds.length === 0
        ? []
        : await tx.catalogProduct.findMany({
            where: { marketId: market.marketId, id: { in: productIds } },
            select: { id: true, publishedRevisionId: true, brandId: true },
          });
    const revisionByProduct = new Map<string, string>();
    for (const product of products) {
      if (product.publishedRevisionId !== null) {
        revisionByProduct.set(product.id, product.publishedRevisionId);
      }
    }
    const revisionIds = [...new Set(revisionByProduct.values())];
    const [texts, categories] =
      revisionIds.length === 0
        ? [[], []]
        : await Promise.all([
            tx.catalogProductRevisionText.findMany({
              where: { marketId: market.marketId, revisionId: { in: revisionIds }, locale },
              select: { revisionId: true, name: true, shortDescription: true },
            }),
            tx.catalogProductRevisionCategory.findMany({
              where: { marketId: market.marketId, revisionId: { in: revisionIds } },
              select: { revisionId: true, categoryId: true },
              orderBy: [{ revisionId: 'asc' }, { position: 'asc' }],
            }),
          ]);
    const attributesByRevision = await this.attributesOf(
      tx,
      market.marketId,
      products.flatMap((product) =>
        product.publishedRevisionId === null
          ? []
          : [{ revisionId: product.publishedRevisionId, brandId: product.brandId }],
      ),
      locale,
    );
    const variantsByRevision = await this.variantsOf(tx, market.marketId, revisionIds, locale);
    // The seller's per-variant switch (V5): a sell unit switched off is not indexed for its Offer.
    // Only `selling = false` rows matter; a unit with no stored row sells.
    const offUnits = new Set(
      offers.length === 0
        ? []
        : (
            await tx.catalogOfferSellUnit.findMany({
              where: {
                marketId: market.marketId,
                offerId: { in: offers.map((offer) => offer.id) },
                selling: false,
              },
              select: { offerId: true, variantId: true },
            })
          ).map((row) => `${row.offerId}:${row.variantId}`),
    );
    const textByRevision = new Map(texts.map((row) => [row.revisionId, row]));
    const categoriesByRevision = new Map<string, Id<'Category'>[]>();
    for (const row of categories) {
      const list = categoriesByRevision.get(row.revisionId) ?? [];
      list.push(row.categoryId as Id<'Category'>);
      categoriesByRevision.set(row.revisionId, list);
    }
    for (const offer of offers) {
      const revisionId = revisionByProduct.get(offer.productId);
      const text = revisionId === undefined ? undefined : textByRevision.get(revisionId);
      const sellable = offer.status === 'published' && offer.listed;
      const variants =
        revisionId === undefined || !sellable
          ? []
          : (variantsByRevision.get(revisionId) ?? []).filter(
              (variant) => !offUnits.has(`${offer.id}:${variant.variantId}`),
            );
      const attributes =
        revisionId === undefined
          ? NO_SEARCH_ATTRIBUTES
          : (attributesByRevision.get(revisionId) ?? NO_SEARCH_ATTRIBUTES);
      result.set(offer.id as Id<'Offer'>, {
        sellerId: offer.sellerId as Id<'Seller'>,
        productId: offer.productId as Id<'Product'>,
        sellable,
        text:
          text === undefined
            ? null
            : { locale, name: text.name, shortDescription: text.shortDescription },
        categoryIds: revisionId === undefined ? [] : (categoriesByRevision.get(revisionId) ?? []),
        attributes:
          variants.length === 0
            ? attributes
            : {
                ...attributes,
                searchText: withVariantWords(
                  attributes.searchText,
                  variants.map((variant) => variant.label),
                ),
              },
        variants,
      });
    }
    return result;
  }

  /**
   * The variants of each published revision (V8): revision rows in position order, kept only while
   * the registry says `published` (a retired variant is never indexed). Axis facets follow the
   * published definitions, merges included. At most {@link MAX_INDEXED_VARIANTS} per revision.
   */
  private async variantsOf(
    tx: MarketTransaction,
    marketId: string,
    revisionIds: readonly string[],
    locale: string,
  ): Promise<ReadonlyMap<string, readonly OfferSearchVariant[]>> {
    const result = new Map<string, OfferSearchVariant[]>();
    if (revisionIds.length === 0) return result;
    const rows = await tx.catalogProductRevisionVariant.findMany({
      where: { marketId, revisionId: { in: [...revisionIds] } },
      select: {
        revisionId: true,
        variantId: true,
        position: true,
        optionValues: true,
        labels: true,
        gtin: true,
      },
      orderBy: [{ revisionId: 'asc' }, { position: 'asc' }],
    });
    if (rows.length === 0) return result;
    const published = await tx.catalogProductVariant.findMany({
      where: { marketId, id: { in: [...new Set(rows.map((row) => row.variantId))] } },
      select: { id: true, state: true },
    });
    const live = new Set(published.filter((v) => v.state === 'published').map((v) => v.id));
    const optionsOf = (value: unknown): Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const definitions = await loadSearchDefinitions(
      tx,
      marketId,
      rows.flatMap((row) => Object.keys(optionsOf(row.optionValues))),
    );
    for (const row of rows) {
      if (!live.has(row.variantId)) continue;
      const list = result.get(row.revisionId) ?? [];
      if (list.length >= MAX_INDEXED_VARIANTS) continue;
      list.push({
        variantId: row.variantId as Id<'Variant'>,
        position: row.position,
        label: variantLabelOf(row.labels, locale),
        gtin: row.gtin,
        facets: buildVariantFacets({ optionValues: optionsOf(row.optionValues), definitions }),
      });
      result.set(row.revisionId, list);
    }
    return result;
  }

  /** The index facts of each published revision (attributes A7); one revision once. */
  private async attributesOf(
    tx: MarketTransaction,
    marketId: string,
    revisions: readonly { readonly revisionId: string; readonly brandId: string | null }[],
    locale: string,
  ): Promise<ReadonlyMap<string, OfferSearchAttributes>> {
    const result = new Map<string, OfferSearchAttributes>();
    if (revisions.length === 0) return result;
    const rows = await tx.catalogProductRevision.findMany({
      where: { marketId, id: { in: revisions.map((row) => row.revisionId) } },
      select: { id: true, attributeValues: true },
    });
    const valuesOf = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const values = row.attributeValues;
      if (values !== null && typeof values === 'object' && !Array.isArray(values)) {
        valuesOf.set(row.id, values);
      }
    }
    const definitions = await loadSearchDefinitions(
      tx,
      marketId,
      [...valuesOf.values()].flatMap((values) => Object.keys(values)),
    );
    const brandIds = [
      ...new Set(revisions.flatMap((row) => (row.brandId === null ? [] : [row.brandId]))),
    ];
    const brands = new Map<string, SearchBrand>();
    if (brandIds.length > 0) {
      const brandRows = await tx.catalogBrand.findMany({
        where: { id: { in: brandIds }, status: 'active' },
        select: { id: true, slug: true, name: true },
      });
      const aliasRows = await tx.catalogBrandAlias.findMany({
        where: { brandId: { in: brandRows.map((row) => row.id) } },
        select: { brandId: true, alias: true },
        orderBy: { alias: 'asc' },
      });
      for (const brand of brandRows) {
        brands.set(brand.id, {
          slug: brand.slug,
          name: brand.name,
          aliases: aliasRows.filter((row) => row.brandId === brand.id).map((row) => row.alias),
        });
      }
    }
    for (const { revisionId, brandId } of revisions) {
      result.set(
        revisionId,
        buildSearchAttributes({
          values: valuesOf.get(revisionId) ?? {},
          definitions,
          brand: brandId === null ? null : (brands.get(brandId) ?? null),
          locale,
        }),
      );
    }
    return result;
  }

  async publishedOfferIds(
    market: MarketContext,
    input: PublishedOfferIdsInput,
  ): Promise<readonly Id<'Offer'>[]> {
    const rows = await this.prisma.tx(market).catalogOffer.findMany({
      where: {
        marketId: market.marketId,
        status: 'published',
        ...(input.productId === undefined ? {} : { productId: input.productId }),
        ...(input.sellerId === undefined ? {} : { sellerId: input.sellerId }),
        ...(input.after === undefined ? {} : { id: { gt: input.after } }),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: input.limit,
    });
    return rows.map((row) => row.id as Id<'Offer'>);
  }

  async searchIndexStamp(market: MarketContext): Promise<string> {
    const tx = this.prisma.tx(market);
    const definitions = await tx.catalogAttributeDefinition.findMany({
      where: { marketId: market.marketId },
      select: { code: true, status: true, publishedRevisionId: true },
      orderBy: { code: 'asc' },
    });
    const brands = await tx.catalogBrand.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    const aliases = await tx.catalogBrandAlias.count();
    // Multi-culture package 3a: a culture's status or required type changes which Offers its code
    // belongs to (`culture_codes`), so it is part of the stamp; the reindex that follows is also the
    // backfill of the column. At most 200 cultures per Market.
    const cultures = await tx.catalogCulture.findMany({
      where: { marketId: market.marketId },
      select: { code: true, status: true, requiredCertificationType: true },
      orderBy: { code: 'asc' },
    });
    // A culture's mark and visibility rows (Mojtaba, #848 item 3): a set moves the latest
    // `updated_at`, a clear moves the count, so the reindex follows a mark change the direct
    // subtree sync handed off (or missed).
    const marks = await tx.catalogCultureCategory.aggregate({
      where: { marketId: market.marketId },
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    const text = [
      ...definitions.map((d) => `${d.code}:${d.status}:${d.publishedRevisionId ?? '-'}`),
      `brands:${brands._count._all}:${brands._max.updatedAt?.toISOString() ?? '-'}`,
      `aliases:${aliases}`,
      ...cultures.map((c) => `culture:${c.code}:${c.status}:${c.requiredCertificationType ?? '-'}`),
      `culture-marks:${marks._count._all}:${marks._max.updatedAt?.toISOString() ?? '-'}`,
    ].join('|');
    return createHash('sha256').update(text).digest('hex').slice(0, 32);
  }
}
