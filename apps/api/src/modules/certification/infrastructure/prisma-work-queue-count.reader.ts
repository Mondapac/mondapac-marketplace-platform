import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { WorkQueueCount } from '../../../platform/work-queue/work-queue-count';
import type { CertificationWorkQueueCountReader } from '../application/ports/work-queue-count.reader';

/** A queue's answer from the submission times of its waiting items. */
function answer(submitted: readonly Date[], staleBefore: Temporal.Instant): WorkQueueCount {
  const before = staleBefore.epochMilliseconds;
  const times = submitted.map((at) => at.getTime());
  return {
    count: times.length,
    overdue: times.filter((at) => at < before).length,
    oldestAt:
      times.length === 0 ? null : Temporal.Instant.fromEpochMilliseconds(Math.min(...times)),
  };
}

/**
 * {@link CertificationWorkQueueCountReader} over Prisma. A certificate waits for review while it
 * names a pending submission (seller) or a pending revision (product), as the review queues read
 * them; it has waited since that submission (`submitted_at`: a renewal leaves the certificate's
 * status, and so its `status_changed_at`, unchanged). Only the submission time of each waiting
 * certificate is selected: the pending items are a reviewer's backlog (tens, not thousands). Each
 * count reads only the waiting rows, through a partial index on `pending_* IS NOT NULL`:
 * `seller_certifications_market_id_pending_idx` (also the seller review queue's) and
 * `product_certifications_market_id_pending_idx`.
 */
export class PrismaCertificationWorkQueueCountReader implements CertificationWorkQueueCountReader {
  constructor(private readonly prisma: PrismaService) {}

  async sellerCertificates(
    market: MarketContext,
    _now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const rows = await this.prisma.tx(market).certificationSellerCertification.findMany({
      where: { marketId: market.marketId, pendingSubmissionId: { not: null } },
      select: { pendingSubmission: { select: { submittedAt: true } } },
    });
    return answer(
      rows.flatMap((row) =>
        row.pendingSubmission === null ? [] : [row.pendingSubmission.submittedAt],
      ),
      staleBefore,
    );
  }

  async productCertificates(
    market: MarketContext,
    _now: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<WorkQueueCount> {
    const rows = await this.prisma.tx(market).certificationProductCertification.findMany({
      where: { marketId: market.marketId, pendingRevisionId: { not: null } },
      select: { pendingRevision: { select: { submittedAt: true } } },
    });
    return answer(
      rows.flatMap((row) =>
        row.pendingRevision === null ? [] : [row.pendingRevision.submittedAt],
      ),
      staleBefore,
    );
  }
}
