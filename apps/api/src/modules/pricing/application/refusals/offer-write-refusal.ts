import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  OfferWriteRefusalsSuppressed,
  OfferWriteRefused,
  type OfferWriteRefusalCause,
} from '../../domain/audit';
import type {
  RefusalAdmission,
  WriteRefusalThrottleRepository,
} from '../ports/write-refusal-throttle.repository';

/** One refusal row per (actor, Offer) per this window (design 5.2, H3). */
export const REFUSAL_WINDOW_MS = 60_000;

/** At most this many refusal rows per actor per window, then one summary row (design 5.2, M7). */
export const REFUSAL_ROWS_PER_ACTOR = 20;

export interface OfferWriteRefusalDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly throttles: WriteRefusalThrottleRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * Records one `pricing.offer-not-found` of a seller's write (pricing design 5.2, 8; Hassan
 * finding 2, H3, M7): one read-write unit (READ COMMITTED) that asks the counters what may be
 * written (`admitRefusal`, which takes the actor row, then the (actor, Offer) row) and writes
 * that audit row, if any, in the same unit, so a counter never advances without its row and a
 * row is never written past its counter. Every cause takes this path, so the timing of the
 * answer does not tell the causes apart. The cause stays inside the row.
 *
 * Throws when the unit fails (the caller's answer is then an error, never a silent success).
 */
export async function recordOfferWriteRefusal(
  deps: OfferWriteRefusalDependencies,
  context: CallContext,
  refusal: {
    readonly accountId: Id<'Account'>;
    readonly offerId: Id<'Offer'>;
    readonly variantId: Id<'Variant'>;
    readonly cause: OfferWriteRefusalCause;
  },
): Promise<RefusalAdmission['kind']> {
  const { market } = context;
  const recorded = await deps.unitOfWork.run(market, async () => {
    const admission = await deps.throttles.admitRefusal(
      market,
      refusal.accountId,
      refusal.offerId,
      deps.clock.now(),
      REFUSAL_WINDOW_MS,
      REFUSAL_ROWS_PER_ACTOR,
    );
    if (admission.kind === 'record') {
      await deps.audit.record(
        context,
        OfferWriteRefused.entry(refusal.offerId, {
          after: { variantId: refusal.variantId, cause: refusal.cause },
        }),
      );
    } else if (admission.kind === 'summarise') {
      await deps.audit.record(
        context,
        OfferWriteRefusalsSuppressed.entry(refusal.accountId, {
          after: { windowStartedAt: admission.windowStartedAt },
        }),
      );
    }
    return ok(admission.kind);
  });
  if (!recorded.ok) throw new Error('pricing: the refusal unit failed');
  return recorded.value;
}
