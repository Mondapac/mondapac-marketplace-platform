import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WorkingCopyRepository } from '../application/ports/working-copy.repository';
import type { WorkingCopy } from '../domain/working-copy';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link WorkingCopyRepository} on `catalog.product_working_copies` (data design 3.6): one row
 * per (Market, product), saved over the previous one with an upsert on the primary key. Every
 * statement goes through `PrismaService.tx(market)` with `marketId` at the top level of `where`.
 */
export class PrismaWorkingCopyRepository implements WorkingCopyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, productId: Id<'Product'>): Promise<WorkingCopy | null> {
    const row = await this.prisma.tx(market).catalogProductWorkingCopy.findFirst({
      where: { marketId: market.marketId, productId },
    });
    if (row === null) return null;
    return {
      productId: row.productId as Id<'Product'>,
      content: row.content as Record<string, unknown>,
      contentSchemaVersion: row.contentSchemaVersion,
      baseRevisionId: row.baseRevisionId as Id<'ProductRevision'> | null,
      lastSavedAt: toInstant(row.lastSavedAt),
      lastSavedByAccountId: row.lastSavedByAccountId as Id<'Account'>,
    };
  }

  async save(market: MarketContext, copy: WorkingCopy): Promise<void> {
    const data = {
      content: copy.content as object,
      contentSchemaVersion: copy.contentSchemaVersion,
      baseRevisionId: copy.baseRevisionId,
      lastSavedAt: toDate(copy.lastSavedAt),
      lastSavedByAccountId: copy.lastSavedByAccountId,
    };
    await this.prisma.tx(market).catalogProductWorkingCopy.upsert({
      where: {
        marketId: market.marketId,
        marketId_productId: { marketId: market.marketId, productId: copy.productId },
      },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        productId: copy.productId,
        ...data,
      },
      update: data,
      select: { productId: true },
    });
  }
}
