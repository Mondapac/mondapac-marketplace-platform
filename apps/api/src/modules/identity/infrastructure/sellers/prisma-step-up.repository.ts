import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import type { StepUpPolicyRow, StepUpRepository } from '../../application/ports/step-up.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link StepUpRepository} on `identity.seller_step_up_policies` and `identity.step_up_proofs`:
 * every statement carries `marketId` at the top level of `where`; single-table writes.
 */
export class PrismaStepUpRepository implements StepUpRepository {
  constructor(private readonly prisma: PrismaService) {}

  async policiesOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<readonly StepUpPolicyRow[]> {
    const rows = await this.prisma.tx(market).identitySellerStepUpPolicy.findMany({
      where: { marketId: market.marketId, sellerId },
      select: { actionKey: true, required: true, updatedAt: true },
      orderBy: { actionKey: 'asc' },
    });
    return rows.map((row) => ({
      actionKey: row.actionKey,
      required: row.required,
      updatedAt: toInstant(row.updatedAt),
    }));
  }

  async policyOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    actionKey: string,
  ): Promise<boolean | null> {
    const row = await this.prisma.tx(market).identitySellerStepUpPolicy.findFirst({
      where: { marketId: market.marketId, sellerId, actionKey },
      select: { required: true },
    });
    return row === null ? null : row.required;
  }

  async savePolicy(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    actionKey: string,
    required: boolean,
    updatedBy: Id<'Account'>,
    now: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).identitySellerStepUpPolicy.upsert({
      where: {
        marketId: market.marketId,
        marketId_sellerId_actionKey: { marketId: market.marketId, sellerId, actionKey },
      },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId,
        actionKey,
        required,
        updatedByAccountId: updatedBy,
        updatedAt: toDate(now),
        version: 1,
      },
      update: {
        required,
        updatedByAccountId: updatedBy,
        updatedAt: toDate(now),
        version: { increment: 1 },
      },
      select: { version: true },
    });
  }

  async proofOf(
    market: MarketContext,
    sessionId: Id<'Session'>,
    actionKey: string,
  ): Promise<Temporal.Instant | null> {
    const row = await this.prisma.tx(market).identityStepUpProof.findFirst({
      where: { marketId: market.marketId, sessionId, actionKey },
      select: { verifiedAt: true },
    });
    return row === null ? null : toInstant(row.verifiedAt);
  }

  async takeProof(
    market: MarketContext,
    sessionId: Id<'Session'>,
    actionKey: string,
  ): Promise<Temporal.Instant | null> {
    const proofs = this.prisma.tx(market).identityStepUpProof;
    const where = { marketId: market.marketId, sessionId, actionKey };
    const row = await proofs.findFirst({ where, select: { verifiedAt: true } });
    if (row === null) return null;
    // The delete takes the row lock: a unit that took the same proof first and committed leaves
    // nothing to delete here, and one that re-verified meanwhile changed `verified_at`. Either way
    // the count is 0 and the proof is not ours (fail closed).
    const { count } = await proofs.deleteMany({ where: { ...where, verifiedAt: row.verifiedAt } });
    return count === 1 ? toInstant(row.verifiedAt) : null;
  }

  async recordProof(
    market: MarketContext,
    sessionId: Id<'Session'>,
    actionKey: string,
    now: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).identityStepUpProof.upsert({
      where: {
        marketId: market.marketId,
        marketId_sessionId_actionKey: { marketId: market.marketId, sessionId, actionKey },
      },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        sessionId,
        actionKey,
        verifiedAt: toDate(now),
      },
      update: { verifiedAt: toDate(now) },
      select: { actionKey: true },
    });
  }
}
