import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  ExpireWrite,
  ExpiryCandidate,
  ExpiryCursor,
  ExpiryNotice,
  SellerCertificateExpiryRepository,
  WarningWrite,
} from '../application/ports/expiry.repository';
import type { SellerCertificationStatus } from '../domain/validity';
import { fromDay, toDate, toInstant } from './prisma-seller-certificate.repository';

/** The marker kind of a seller certificate's submission (data design 3.18). */
const SUBMISSION_KIND = 'submission';

const CANDIDATE_SELECT = {
  id: true,
  version: true,
  sellerId: true,
  typeId: true,
  status: true,
  approvedSubmissionId: true,
  approvedBoundaryAt: true,
  approvedSubmission: {
    select: {
      typeRevisionId: true,
      expiryDate: true,
      typeRevision: { select: { requiresExpiry: true } },
      decision: { select: { outcome: true, approvedZone: true, expiryBoundaryAt: true } },
    },
  },
} as const;

/**
 * {@link SellerCertificateExpiryRepository} on the tables of `certification` (data design 3.4,
 * 3.6, 3.18). The selection uses the partial index A9 `(market_id, approved_boundary_at) WHERE
 * status = 'approved'`; the boundary the job acts on is computed in the domain from the approved
 * decision row (the root's copy only selects). Writes to the root first move its version under
 * the expected one with a guarded `updateMany`, which takes the row lock.
 */
export class PrismaSellerCertificateExpiryRepository implements SellerCertificateExpiryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async candidates(
    market: MarketContext,
    horizon: Temporal.Instant,
    after: ExpiryCursor | null,
    limit: number,
  ): Promise<readonly ExpiryCandidate[]> {
    const tx = this.prisma.tx(market);
    const window = { lt: toDate(horizon) };
    const rows = await tx.certificationSellerCertification.findMany({
      where: {
        marketId: market.marketId,
        status: 'approved',
        approvedBoundaryAt: window,
        ...(after === null
          ? {}
          : {
              OR: [
                { approvedBoundaryAt: { gt: toDate(after.boundary) } },
                { approvedBoundaryAt: toDate(after.boundary), id: { gt: after.certificateId } },
              ],
            }),
      },
      select: CANDIDATE_SELECT,
      orderBy: [{ approvedBoundaryAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const warned = await this.#warned(
      market,
      rows.flatMap((row) => (row.approvedSubmissionId === null ? [] : [row.approvedSubmissionId])),
    );
    return rows.flatMap((row) => {
      const candidate = toCandidate(row, warned);
      return candidate === null ? [] : [candidate];
    });
  }

  async candidate(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
  ): Promise<ExpiryCandidate | null> {
    const row = await this.prisma.tx(market).certificationSellerCertification.findFirst({
      where: { marketId: market.marketId, id: certificateId },
      select: CANDIDATE_SELECT,
    });
    if (row === null || row.approvedSubmissionId === null) return null;
    const warned = await this.#warned(market, [row.approvedSubmissionId]);
    return toCandidate(row, warned);
  }

  async lockVersion(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
    expectedVersion: number,
    now: Temporal.Instant,
  ): Promise<void> {
    const { count } = await this.prisma.tx(market).certificationSellerCertification.updateMany({
      where: { marketId: market.marketId, id: certificateId, version: expectedVersion },
      data: { version: expectedVersion + 1, lastChangedAt: toDate(now) },
    });
    if (count !== 1) throw new StaleAggregateError('seller-certification', certificateId);
  }

  async expire(market: MarketContext, write: ExpireWrite): Promise<void> {
    const tx = this.prisma.tx(market);
    const { count } = await tx.certificationSellerCertification.updateMany({
      where: {
        marketId: market.marketId,
        id: write.certificateId,
        status: 'approved',
        approvedSubmissionId: write.submissionId,
      },
      data: { status: 'expired', statusChangedAt: toDate(write.now) },
    });
    if (count !== 1) throw new StaleAggregateError('seller-certification', write.certificateId);
    await tx.certificationSellerCertificationHistory.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        id: write.historyId,
        sellerCertificationId: write.certificateId,
        fromStatus: 'approved',
        toStatus: 'expired',
        submissionId: write.submissionId,
        actorKind: 'system',
        actorAccountId: null,
        reasonCode: null,
        occurredAt: toDate(write.now),
      },
      select: { id: true },
    });
  }

  async recordWarning(market: MarketContext, write: WarningWrite): Promise<void> {
    await this.prisma.tx(market).certificationExpiryWarning.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        versionKind: SUBMISSION_KIND,
        versionId: write.submissionId,
        thresholdDays: write.thresholdDays,
        createdAt: toDate(write.now),
      },
      select: { versionId: true },
    });
  }

  async notice(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
  ): Promise<ExpiryNotice | null> {
    const row = await this.prisma.tx(market).certificationSellerCertification.findFirst({
      where: { marketId: market.marketId, id: certificateId },
      select: {
        sellerId: true,
        status: true,
        approvedSubmissionId: true,
        type: { select: { code: true } },
        approvedSubmission: { select: { expiryDate: true } },
      },
    });
    if (row === null) return null;
    return {
      sellerId: row.sellerId as Id<'Seller'>,
      typeCode: row.type.code,
      status: row.status as SellerCertificationStatus,
      approvedSubmissionId: row.approvedSubmissionId as Id<'Submission'> | null,
      expiryDate: fromDay(row.approvedSubmission?.expiryDate ?? null),
    };
  }

  /** The thresholds already marked per submission. */
  async #warned(
    market: MarketContext,
    submissionIds: readonly string[],
  ): Promise<ReadonlyMap<string, number[]>> {
    const warned = new Map<string, number[]>();
    if (submissionIds.length === 0) return warned;
    const rows = await this.prisma.tx(market).certificationExpiryWarning.findMany({
      where: {
        marketId: market.marketId,
        versionKind: SUBMISSION_KIND,
        versionId: { in: [...submissionIds] },
      },
      select: { versionId: true, thresholdDays: true },
    });
    for (const row of rows) {
      const list = warned.get(row.versionId) ?? [];
      list.push(row.thresholdDays);
      warned.set(row.versionId, list);
    }
    return warned;
  }
}

type CandidateRow = {
  readonly id: string;
  readonly version: number;
  readonly sellerId: string;
  readonly typeId: string;
  readonly status: string;
  readonly approvedSubmissionId: string | null;
  readonly approvedBoundaryAt: Date | null;
  readonly approvedSubmission: {
    readonly typeRevisionId: string;
    readonly expiryDate: Date | null;
    readonly typeRevision: { readonly requiresExpiry: boolean };
    readonly decision: {
      readonly outcome: string;
      readonly approvedZone: string | null;
      readonly expiryBoundaryAt: Date | null;
    } | null;
  } | null;
};

/**
 * The candidate from the root and its approved submission. Only an approved decision gives the
 * facts; anything else (no pointer, no decision row) is no candidate, so nothing moves.
 */
function toCandidate(
  row: CandidateRow,
  warned: ReadonlyMap<string, number[]>,
): ExpiryCandidate | null {
  const submission = row.approvedSubmission;
  if (
    row.approvedSubmissionId === null ||
    submission === null ||
    submission.decision === null ||
    submission.decision.outcome !== 'approved'
  ) {
    return null;
  }
  const stored = submission.decision.expiryBoundaryAt;
  return {
    certificateId: row.id as Id<'SellerCertification'>,
    version: row.version,
    sellerId: row.sellerId as Id<'Seller'>,
    typeId: row.typeId as Id<'CertificationType'>,
    submissionId: row.approvedSubmissionId as Id<'Submission'>,
    typeRevisionId: submission.typeRevisionId as Id<'CertificationTypeRevision'>,
    status: row.status as SellerCertificationStatus,
    requiresExpiry: submission.typeRevision.requiresExpiry,
    expiryDate: fromDay(submission.expiryDate),
    zoneAtApproval: submission.decision.approvedZone,
    storedBoundary: stored === null ? null : toInstant(stored),
    warnedThresholds: warned.get(row.approvedSubmissionId) ?? [],
    selectionBoundary: toInstant(row.approvedBoundaryAt ?? stored ?? new Date(0)),
  };
}
