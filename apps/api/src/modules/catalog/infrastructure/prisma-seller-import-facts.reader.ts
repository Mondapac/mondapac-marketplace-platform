import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SellerImportFactsReader } from '../application/ports/seller-import-facts.reader';
import { optionKeyOf } from '../domain/revision-freeze';
import type {
  CatalogueProductFact,
  ExistingOfferFact,
  SellerCheckFacts,
} from '../domain/seller-import/row-check';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function optionValuesOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(value)) return out;
  for (const [code, option] of Object.entries(value)) {
    if (typeof option === 'string') out[code] = option;
  }
  return out;
}

/**
 * {@link SellerImportFactsReader} on the catalog tables (catalog design 14c). The seller's Offers
 * are read by seller and SKU; the variants of a SELLER product take their option values from the
 * working copy when it names the variant, else from the published revision.
 */
export class PrismaSellerImportFactsReader implements SellerImportFactsReader {
  constructor(private readonly prisma: PrismaService) {}

  async load(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    keys: { readonly skus: readonly string[]; readonly productCodes: readonly string[] },
  ): Promise<SellerCheckFacts> {
    const tx = this.prisma.tx(market);
    const { marketId } = market;

    const offers =
      keys.skus.length === 0
        ? []
        : await tx.catalogOffer.findMany({
            where: { marketId, sellerId, deletedAt: null, sellerSku: { in: [...keys.skus] } },
            select: { id: true, productId: true, sellerSku: true },
          });

    const catalogue =
      keys.productCodes.length === 0
        ? []
        : await tx.catalogProduct.findMany({
            where: {
              marketId,
              scope: 'PLATFORM',
              status: 'published',
              retiredAt: null,
              pausedAt: null,
              publishedRevisionId: { not: null },
              productCode: { in: [...keys.productCodes] },
            },
            select: { id: true, productCode: true, typeCode: true },
          });
    const catalogueByCode = new Map<string, CatalogueProductFact>();
    for (const product of catalogue) {
      catalogueByCode.set(product.productCode, {
        productId: product.id,
        typeCode: product.typeCode,
      });
    }

    const productIds = [
      ...new Set([...offers.map((o) => o.productId), ...catalogue.map((p) => p.id)]),
    ];
    const ownOnProducts =
      productIds.length === 0
        ? []
        : await tx.catalogOffer.findMany({
            where: { marketId, sellerId, deletedAt: null, productId: { in: productIds } },
            select: { productId: true, sellerSku: true },
          });
    const ownSkuByProductId = new Map<string, string>();
    for (const offer of ownOnProducts) ownSkuByProductId.set(offer.productId, offer.sellerSku);

    const offerProductIds = [...new Set(offers.map((offer) => offer.productId))];
    const products =
      offerProductIds.length === 0
        ? []
        : await tx.catalogProduct.findMany({
            where: { marketId, id: { in: offerProductIds } },
            select: {
              id: true,
              scope: true,
              typeCode: true,
              publishedRevisionId: true,
              variants: { where: { state: { not: 'retired' } }, select: { id: true } },
            },
          });
    const sellerProductIds = products.filter((p) => p.scope === 'SELLER').map((p) => p.id);
    const copies =
      sellerProductIds.length === 0
        ? []
        : await tx.catalogProductWorkingCopy.findMany({
            where: { marketId, productId: { in: sellerProductIds } },
            select: { productId: true, content: true },
          });
    const revisionIds = products.flatMap((p) =>
      p.publishedRevisionId === null || p.scope !== 'SELLER' ? [] : [p.publishedRevisionId],
    );
    const revisionVariants =
      revisionIds.length === 0
        ? []
        : await tx.catalogProductRevisionVariant.findMany({
            where: { marketId, revisionId: { in: revisionIds } },
            select: { revisionId: true, variantId: true, optionKey: true, optionValues: true },
          });

    const draftOptions = new Map<string, Map<string, string>>();
    for (const copy of copies) {
      const byVariant = new Map<string, string>();
      const variants = isObject(copy.content) ? copy.content['variants'] : undefined;
      if (Array.isArray(variants)) {
        for (const variant of variants as unknown[]) {
          if (!isObject(variant) || typeof variant['variantId'] !== 'string') continue;
          byVariant.set(variant['variantId'], optionKeyOf(optionValuesOf(variant['optionValues'])));
        }
      }
      draftOptions.set(copy.productId, byVariant);
    }
    const factOf = new Map<string, Omit<ExistingOfferFact, 'offerId' | 'sellerSku'>>();
    for (const product of products) {
      const published =
        product.publishedRevisionId === null
          ? []
          : revisionVariants.filter((v) => v.revisionId === product.publishedRevisionId);
      const draft = draftOptions.get(product.id);
      factOf.set(product.id, {
        productId: product.id,
        productScope: product.scope as 'PLATFORM' | 'SELLER',
        productTypeCode: product.typeCode,
        variants:
          product.scope === 'SELLER'
            ? product.variants.map((variant) => ({
                variantId: variant.id,
                optionKey:
                  draft?.get(variant.id) ??
                  published.find((v) => v.variantId === variant.id)?.optionKey ??
                  '',
              }))
            : [],
        publishedAxes:
          product.publishedRevisionId === null
            ? null
            : [...new Set(published.flatMap((v) => Object.keys(optionValuesOf(v.optionValues))))],
      });
    }

    const offersBySku = new Map<string, ExistingOfferFact>();
    for (const offer of offers) {
      const fact = factOf.get(offer.productId);
      if (fact === undefined) continue;
      offersBySku.set(offer.sellerSku, { ...fact, offerId: offer.id, sellerSku: offer.sellerSku });
    }
    return { offersBySku, ownSkuByProductId, catalogueByCode };
  }
}
