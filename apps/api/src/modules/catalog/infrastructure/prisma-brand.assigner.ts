import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { BrandAssigner } from '../application/ports/brand-assigner';
import { BRAND_NAME_MAX, isBrandSlug, tidyBrandName } from '../domain/brand';

/**
 * {@link BrandAssigner} on `catalog.brands`, `brand_aliases` and `catalog.products.brand_id`. The
 * lookups read brand rows (exempt from the market scope); the one write is a single `updateMany` of
 * the product row of the unit's Market. A trigger in the database refuses a `brand_id` that names
 * no brand.
 */
export class PrismaBrandAssigner implements BrandAssigner {
  constructor(private readonly prisma: PrismaService) {}

  async assignFromPublished(
    market: MarketContext,
    productId: Id<'Product'>,
    brandValue: string | null,
  ): Promise<void> {
    const brandId = brandValue === null ? null : await this.#resolve(market, brandValue);
    await this.prisma.tx(market).catalogProduct.updateMany({
      where: { marketId: market.marketId, id: productId },
      data: { brandId },
    });
  }

  /** The id of the active brand a value names, or null. See {@link BrandAssigner}. */
  async #resolve(market: MarketContext, value: string): Promise<string | null> {
    const name = tidyBrandName(value);
    if (name === '' || name.length > BRAND_NAME_MAX) return null;
    const tx = this.prisma.tx(market);

    const exact = await tx.catalogBrand.findFirst({
      where: { status: 'active', name },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (exact !== null) return exact.id;

    if (isBrandSlug(name)) {
      const bySlug = await tx.catalogBrand.findFirst({
        where: { status: 'active', slug: name },
        select: { id: true },
      });
      if (bySlug !== null) return bySlug.id;
    }

    // Without regard to case: only when one brand has the spelling. Two (the migration keeps
    // "Acme" and "ACME" apart until an admin merges them) cannot be told apart from a lower-case
    // value, so the value stays unresolved.
    const insensitive = await tx.catalogBrand.findMany({
      where: { status: 'active', name: { equals: name, mode: 'insensitive' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 2,
      select: { id: true },
    });
    if (insensitive.length === 1) return insensitive[0]!.id;
    if (insensitive.length > 1) return null;

    const alias = await tx.catalogBrandAlias.findFirst({
      where: { alias: { equals: name, mode: 'insensitive' }, brand: { status: 'active' } },
      select: { brandId: true },
    });
    return alias === null ? null : alias.brandId;
  }
}
