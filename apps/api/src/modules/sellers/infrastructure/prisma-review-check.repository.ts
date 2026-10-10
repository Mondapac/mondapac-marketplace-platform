import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ReviewCheckRepository } from '../application/ports/review-check.repository';
import {
  MANUAL_REGISTER_CHECK,
  OBSERVED_REGISTER_OUTCOMES,
  type ManualRegisterCheck,
  type ObservedRegisterOutcome,
} from '../domain/review-check';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** A stored row that breaks the domain's rules: a fault of the data, never a value to use. */
export class StoredReviewCheckError extends Error {
  override readonly name = 'StoredReviewCheckError';
  constructor(column: string) {
    super(`sellers.review_checks holds an invalid ${column}`);
  }
}

/**
 * {@link ReviewCheckRepository} on `sellers.review_checks` (data design 3.3). Every statement goes
 * through `PrismaService.tx(market)` with `marketId` at the top level of `where` and names the
 * seller, so it never reads or writes another seller's check. The record is an upsert on the key.
 */
export class PrismaReviewCheckRepository implements ReviewCheckRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findManualRegisterCheck(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revisionId: Id<'BusinessFileRevision'>,
  ): Promise<ManualRegisterCheck | null> {
    const row = await this.prisma.tx(market).sellersReviewCheck.findFirst({
      where: { marketId: market.marketId, sellerId, revisionId, checkCode: MANUAL_REGISTER_CHECK },
      select: {
        result: true,
        observedRegisterOutcome: true,
        recordedByAccountId: true,
        recordedAt: true,
      },
    });
    if (row === null || row.result !== 'done') return null;
    const observed = row.observedRegisterOutcome;
    if (
      observed === null ||
      !(OBSERVED_REGISTER_OUTCOMES as readonly string[]).includes(observed)
    ) {
      throw new StoredReviewCheckError('observed_register_outcome');
    }
    return {
      revisionId,
      observed: observed as ObservedRegisterOutcome,
      recordedByAccountId: row.recordedByAccountId as Id<'Account'>,
      recordedAt: toInstant(row.recordedAt),
    };
  }

  async recordManualRegisterCheck(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    check: ManualRegisterCheck,
  ): Promise<void> {
    const values = {
      result: 'done',
      observedRegisterOutcome: check.observed,
      recordedByAccountId: check.recordedByAccountId,
      recordedAt: toDate(check.recordedAt),
    };
    const tx = this.prisma.tx(market);
    const { count } = await tx.sellersReviewCheck.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId,
          revisionId: check.revisionId,
          checkCode: MANUAL_REGISTER_CHECK,
          ...values,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return;
    const { count: updated } = await tx.sellersReviewCheck.updateMany({
      where: {
        marketId: market.marketId,
        sellerId,
        revisionId: check.revisionId,
        checkCode: MANUAL_REGISTER_CHECK,
      },
      data: values,
    });
    if (updated !== 1)
      throw new Error('sellers.review_checks: the check was neither added nor replaced');
  }
}
