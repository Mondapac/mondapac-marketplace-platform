import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { ProductRepository } from '../application/ports/product.repository';
import {
  Product,
  formatProductCode,
  type ProductScope,
  type ProductStatus,
  type VariantRecord,
  type VariantState,
} from '../domain/product';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const orNull = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

/**
 * {@link ProductRepository} on `catalog.products`, `product_variants` and
 * `product_code_counters`. Every statement goes through `PrismaService.tx(market)` with
 * `marketId` at the top level of `where`; writes are single statements, never nested. No row is
 * ever deleted (Q-K2): a discard is a status and a retired variant.
 */
export class PrismaProductRepository implements ProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  async nextProductCode(market: MarketContext): Promise<string> {
    // The market guard refuses an upsert by id, and the counter's id is its Market, so the row is
    // ensured first (a no-op when it exists and no lock), then raised by one in a single
    // statement whose row lock lasts to the end of the unit; the value read is therefore ours.
    // The row starts at 1 (the value to hand out next), so the value taken is the one read
    // after the increment minus one.
    const tx = this.prisma.tx(market);
    await tx.catalogProductCodeCounter.createMany({
      data: [{ marketId: market.marketId, tenantId: market.tenantId, nextValue: 1n }],
      skipDuplicates: true,
    });
    await tx.catalogProductCodeCounter.updateMany({
      where: { marketId: market.marketId },
      data: { nextValue: { increment: 1n } },
    });
    const counter = await tx.catalogProductCodeCounter.findFirstOrThrow({
      where: { marketId: market.marketId },
      select: { nextValue: true },
    });
    return formatProductCode(Number(counter.nextValue - 1n));
  }

  async add(market: MarketContext, product: Product): Promise<void> {
    const state = product.state;
    if (state.marketId !== market.marketId)
      throw new Error('add: the product is of another Market');
    const tx = this.prisma.tx(market);
    await tx.catalogProduct.create({
      data: {
        id: state.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        scope: state.scope,
        ownerSellerId: state.ownerSellerId,
        createdBySellerId: state.createdBySellerId,
        typeCode: state.typeCode,
        variantModel: state.variantModel,
        familyCode: state.familyCode,
        productCode: state.productCode,
        status: state.status,
        discardedAt: state.discardedAt === null ? null : toDate(state.discardedAt),
        ownBrand: state.ownBrand,
        lastChangedAt: toDate(state.lastChangedAt),
        version: state.version,
        createdAt: toDate(state.createdAt),
      },
      select: { id: true },
    });
    if (state.variants.length === 0) return;
    await tx.catalogProductVariant.createMany({
      data: state.variants.map((variant) => ({
        id: variant.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        productId: state.id,
        variantModel: state.variantModel,
        state: variant.state,
        createdAt: toDate(variant.createdAt),
        publishedAt: variant.publishedAt === null ? null : toDate(variant.publishedAt),
        retiredAt: variant.retiredAt === null ? null : toDate(variant.retiredAt),
      })),
    });
  }

  async findById(market: MarketContext, id: Id<'Product'>): Promise<Product | null> {
    const row = await this.prisma.tx(market).catalogProduct.findFirst({
      where: { marketId: market.marketId, id },
      include: { variants: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (row === null) return null;
    return Product.restore({
      id: row.id as Id<'Product'>,
      marketId: row.marketId as MarketId,
      scope: row.scope as ProductScope,
      ownerSellerId: row.ownerSellerId as Id<'Seller'> | null,
      createdBySellerId: row.createdBySellerId as Id<'Seller'> | null,
      typeCode: row.typeCode,
      variantModel: row.variantModel as 'single' | 'options',
      familyCode: row.familyCode,
      productCode: row.productCode,
      status: row.status as ProductStatus,
      discardedAt: orNull(row.discardedAt),
      ownBrand: row.ownBrand,
      lastChangedAt: toInstant(row.lastChangedAt),
      version: row.version,
      createdAt: toInstant(row.createdAt),
      variants: row.variants.map((variant): VariantRecord => ({
        id: variant.id as Id<'Variant'>,
        state: variant.state as VariantState,
        createdAt: toInstant(variant.createdAt),
        publishedAt: orNull(variant.publishedAt),
        retiredAt: orNull(variant.retiredAt),
      })),
    });
  }

  async save(market: MarketContext, product: Product): Promise<void> {
    const state = product.state;
    const expected = product.persistedVersion;
    if (expected === null) throw new Error('save: the product was never stored; use add');
    if (state.marketId !== market.marketId)
      throw new Error('save: the product is of another Market');
    if (state.version === expected) return;
    const tx = this.prisma.tx(market);
    // The product first: the variant guard reads the product's status when a Simple product's
    // single variant is retired with its discarded product.
    const { count } = await tx.catalogProduct.updateMany({
      where: { marketId: market.marketId, id: state.id, version: expected },
      data: {
        status: state.status,
        discardedAt: state.discardedAt === null ? null : toDate(state.discardedAt),
        lastChangedAt: toDate(state.lastChangedAt),
        version: state.version,
      },
    });
    if (count !== 1) throw new StaleAggregateError('product', state.id);

    const stored = new Map(
      (
        await tx.catalogProductVariant.findMany({
          where: { marketId: market.marketId, productId: state.id },
          select: { id: true, state: true },
        })
      ).map((row) => [row.id, row.state]),
    );
    const added = state.variants.filter((variant) => !stored.has(variant.id));
    if (added.length > 0) {
      await tx.catalogProductVariant.createMany({
        data: added.map((variant) => ({
          id: variant.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          productId: state.id,
          variantModel: state.variantModel,
          state: variant.state,
          createdAt: toDate(variant.createdAt),
          publishedAt: variant.publishedAt === null ? null : toDate(variant.publishedAt),
          retiredAt: variant.retiredAt === null ? null : toDate(variant.retiredAt),
        })),
      });
    }
    for (const variant of state.variants) {
      if (stored.get(variant.id) === undefined || stored.get(variant.id) === variant.state)
        continue;
      await tx.catalogProductVariant.updateMany({
        where: { marketId: market.marketId, productId: state.id, id: variant.id },
        data: {
          state: variant.state,
          publishedAt: variant.publishedAt === null ? null : toDate(variant.publishedAt),
          retiredAt: variant.retiredAt === null ? null : toDate(variant.retiredAt),
        },
      });
    }
  }
}
