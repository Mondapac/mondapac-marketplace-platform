import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import { fieldLabel } from '../../../../platform/subject-keys/labels';
import {
  SubjectKeyIntegrityError,
  type SubjectKeyService,
} from '../../../../platform/subject-keys/subject-key-service';
import {
  AccessReasonIntegrityError,
  AccessReasonKeyUnavailableError,
  type AccessDecisionBasisRow,
  type AccessDecisionRepository,
  type StoredAccessDecision,
} from '../../application/ports/access-decision.repository';
import {
  ACCESS_DECISIONS,
  AccessDecision,
  type AccessDecisionKind,
} from '../../domain/access-decision';

/**
 * The label of an encrypted reason (data design 3.11, D 11.3): bound into its ciphertext, so a
 * value copied to another field, seller or Market does not open.
 */
export const ACCESS_DECISION_REASON = fieldLabel('identity.access-decision.reason');

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const SELECTED = {
  id: true,
  sellerId: true,
  decision: true,
  reasonCiphertext: true,
  basisId: true,
  decidedByAccountId: true,
  decidedAt: true,
} as const;

interface DecisionRow {
  readonly id: string;
  readonly sellerId: string;
  readonly decision: string;
  readonly reasonCiphertext: string | null;
  readonly basisId: string | null;
  readonly decidedByAccountId: string | null;
  readonly decidedAt: Date;
}

/**
 * {@link AccessDecisionRepository} on `identity.access_decisions` (data design 3.11): insert and
 * read only, as the table's privileges allow. Every statement goes through
 * `PrismaService.tx(market)` with `marketId` at the top level of `where`. The reason is sealed and
 * opened with the `SubjectKeyService` under the seller's key, in the caller's unit (PF 4 row 8);
 * a ciphertext that does not open throws {@link AccessReasonIntegrityError} (the service's
 * integrity error, as the port names it), never a null reason.
 */
export class PrismaAccessDecisionRepository implements AccessDecisionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subjectKeys: SubjectKeyService,
  ) {}

  async add(market: MarketContext, decision: AccessDecision): Promise<void> {
    const state = decision.state;
    let reasonCiphertext: string | null = null;
    if (state.reason !== null) {
      const sealed = await this.subjectKeys.encrypt(
        market,
        state.sellerId,
        ACCESS_DECISION_REASON,
        state.reason,
      );
      if (!sealed.ok) throw new AccessReasonKeyUnavailableError();
      reasonCiphertext = sealed.value;
    }
    await this.prisma.tx(market).identityAccessDecision.create({
      data: {
        id: state.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId: state.sellerId,
        decision: state.decision,
        reasonCiphertext,
        basisId: state.basisId,
        decidedByAccountId: state.decidedByAccountId,
        decidedAt: toDate(state.decidedAt),
      },
      select: { id: true },
    });
  }

  async findById(
    market: MarketContext,
    id: Id<'AccessDecision'>,
  ): Promise<StoredAccessDecision | null> {
    const row = await this.prisma.tx(market).identityAccessDecision.findFirst({
      where: { marketId: market.marketId, id },
      select: SELECTED,
    });
    return row === null ? null : this.read(market, row);
  }

  async latestOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<StoredAccessDecision | null> {
    // On the index (market_id, seller_id, decided_at); the id breaks a tie of instants (UUIDv7).
    const row = await this.prisma.tx(market).identityAccessDecision.findFirst({
      where: { marketId: market.marketId, sellerId },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      select: SELECTED,
    });
    return row === null ? null : this.read(market, row);
  }

  async historyOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    limit: number,
  ): Promise<readonly StoredAccessDecision[]> {
    // On the index (market_id, seller_id, decided_at), as latestOf; the id breaks a tie.
    const rows = await this.prisma.tx(market).identityAccessDecision.findMany({
      where: { marketId: market.marketId, sellerId },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: SELECTED,
    });
    const read: StoredAccessDecision[] = [];
    // One after another: one key unwrap per operation (PF 4 row 9), in this unit.
    for (const row of rows) read.push(await this.read(market, row));
    return read;
  }

  async findByBasis(
    market: MarketContext,
    basisIds: readonly Id[],
  ): Promise<readonly AccessDecisionBasisRow[]> {
    if (basisIds.length === 0) return [];
    // On the index (market_id, basis_id) (`= ANY`). The reason column is not selected at all.
    const rows = await this.prisma.tx(market).identityAccessDecision.findMany({
      where: { marketId: market.marketId, basisId: { in: [...basisIds] } },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, sellerId: true, decision: true, basisId: true, decidedAt: true },
    });
    return rows.map((row) => {
      if (!(ACCESS_DECISIONS as readonly string[]).includes(row.decision) || row.basisId === null) {
        throw new Error('identity.access_decisions: a stored decision is malformed');
      }
      return {
        id: row.id as Id<'AccessDecision'>,
        sellerId: row.sellerId as Id<'Seller'>,
        decision: row.decision as AccessDecisionKind,
        basisId: row.basisId as Id,
        decidedAt: toInstant(row.decidedAt),
      };
    });
  }

  private async read(market: MarketContext, row: DecisionRow): Promise<StoredAccessDecision> {
    if (!(ACCESS_DECISIONS as readonly string[]).includes(row.decision)) {
      throw new Error('identity.access_decisions: a stored decision is malformed');
    }
    const decision = row.decision as AccessDecisionKind;
    if (AccessDecision.needsReason(decision) !== (row.reasonCiphertext !== null)) {
      throw new Error('identity.access_decisions: a stored reason is malformed');
    }
    const sellerId = row.sellerId as Id<'Seller'>;
    let reason: string | null = null;
    let reasonErased = false;
    if (row.reasonCiphertext !== null) {
      const opened = await openReason(this.subjectKeys, market, sellerId, row.reasonCiphertext);
      if (opened.ok) reason = opened.value;
      else reasonErased = true;
    }
    return {
      id: row.id as Id<'AccessDecision'>,
      sellerId,
      decision,
      reason,
      reasonErased,
      basisId: row.basisId as Id | null,
      decidedByAccountId: row.decidedByAccountId as Id<'Account'> | null,
      decidedAt: toInstant(row.decidedAt),
    };
  }
}

/** Opens a reason; the service's integrity failure becomes the port's (slice 9a, Hassan C2). */
async function openReason(
  subjectKeys: SubjectKeyService,
  market: MarketContext,
  sellerId: Id<'Seller'>,
  cipher: string,
): ReturnType<SubjectKeyService['decrypt']> {
  try {
    return await subjectKeys.decrypt(market, sellerId, ACCESS_DECISION_REASON, cipher);
  } catch (error) {
    if (error instanceof SubjectKeyIntegrityError)
      throw new AccessReasonIntegrityError(error.reason);
    throw error;
  }
}
