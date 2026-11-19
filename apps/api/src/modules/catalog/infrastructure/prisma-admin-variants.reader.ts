import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  MarketTransaction,
  PrismaService,
} from '../../../platform/persistence/prisma.service';
import type {
  AdminVariantRow,
  AdminVariantsReader,
} from '../application/ports/admin-variants.reader';
import { variantCodeOf } from '../domain/product';
import { readAxisValues } from './variant-axis-values';

/** Ids per statement, so the lists stay far under the parameter limit. */
const CHUNK = 500;

const stringMap = (value: unknown): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};

interface PublishedVariant {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly variantNo: number;
  readonly gtin: string | null;
  readonly optionValues: unknown;
}

/**
 * {@link AdminVariantsReader}: per product the published revision (the product's
 * `published_revision_id`), that revision's variants, and the variant registry to keep those whose
 * state is `published` and to read their numbers. Option labels follow the published attribute
 * definitions, as the storefront's do. Every statement is scoped by `market_id`; no join across
 * modules, and no price or stock is read.
 */
export class PrismaAdminVariantsReader implements AdminVariantsReader {
  constructor(private readonly prisma: PrismaService) {}

  async count(market: MarketContext, productIds: readonly Id<'Product'>[]): Promise<number> {
    let total = 0;
    const tx = this.prisma.tx(market);
    for (let start = 0; start < productIds.length; start += CHUNK) {
      total += (await this.published(tx, market, productIds.slice(start, start + CHUNK))).length;
    }
    return total;
  }

  async axisCodes(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<readonly string[]> {
    const codes = new Set<string>();
    const tx = this.prisma.tx(market);
    for (let start = 0; start < productIds.length; start += CHUNK) {
      for (const variant of await this.published(
        tx,
        market,
        productIds.slice(start, start + CHUNK),
      )) {
        const values = stringMap(variant.optionValues);
        for (const code of Object.keys(values)) codes.add(code);
      }
    }
    return [...codes].sort();
  }

  async rows(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    locale: string,
  ): Promise<readonly AdminVariantRow[]> {
    if (productIds.length === 0) return [];
    const tx = this.prisma.tx(market);
    const variants = await this.published(tx, market, productIds);
    const axes = await readAxisValues(
      tx,
      market.marketId,
      variants.map((variant) => variant.optionValues),
      { requested: locale, fallback: locale },
    );
    const offerCounts = await tx.catalogOffer.groupBy({
      by: ['productId'],
      where: {
        marketId: market.marketId,
        productId: { in: [...new Set(variants.map((variant) => variant.productId))] },
        status: { not: 'deleted' },
      },
      _count: { _all: true },
    });
    const offersOf = new Map(offerCounts.map((row) => [row.productId, row._count._all]));
    const position = new Map(productIds.map((id, index) => [id as string, index]));
    return variants
      .map((variant, index) => ({ variant, axes: axes[index]! }))
      .sort(
        (a, b) =>
          position.get(a.variant.productId)! - position.get(b.variant.productId)! ||
          a.variant.variantNo - b.variant.variantNo,
      )
      .map(({ variant, axes: options }): AdminVariantRow => ({
        productId: variant.productId as Id<'Product'>,
        productCode: variant.productCode,
        typeCode: variant.typeCode,
        variantCode: variantCodeOf(variant.productCode, variant.variantNo),
        options,
        gtin: variant.gtin,
        offerCount: offersOf.get(variant.productId) ?? 0,
      }));
  }

  /** The variants of the published revisions of these products, whose registry state is published. */
  private async published(
    tx: MarketTransaction,
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<PublishedVariant[]> {
    if (productIds.length === 0) return [];
    const products = await tx.catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...productIds] },
        publishedRevisionId: { not: null },
      },
      select: { id: true, productCode: true, typeCode: true, publishedRevisionId: true },
    });
    if (products.length === 0) return [];
    const productOfRevision = new Map(
      products.map((product) => [product.publishedRevisionId!, product]),
    );
    const revisionVariants = await tx.catalogProductRevisionVariant.findMany({
      where: { marketId: market.marketId, revisionId: { in: [...productOfRevision.keys()] } },
      select: { revisionId: true, variantId: true, gtin: true, optionValues: true },
    });
    if (revisionVariants.length === 0) return [];
    const registry = await tx.catalogProductVariant.findMany({
      where: {
        marketId: market.marketId,
        id: { in: revisionVariants.map((row) => row.variantId) },
        state: 'published',
      },
      select: { id: true, variantNo: true },
    });
    const numberOf = new Map(registry.map((row) => [row.id, row.variantNo]));
    return revisionVariants.flatMap((row): PublishedVariant[] => {
      const variantNo = numberOf.get(row.variantId);
      const product = productOfRevision.get(row.revisionId);
      if (variantNo === undefined || product === undefined) return [];
      return [
        {
          productId: product.id,
          productCode: product.productCode,
          typeCode: product.typeCode,
          variantNo,
          gtin: row.gtin,
          optionValues: row.optionValues,
        },
      ];
    });
  }
}
