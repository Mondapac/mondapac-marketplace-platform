import { Logger } from '@nestjs/common';
import { money, ok } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { FirstPriceRechecked } from '../../domain/audit';
import { OfferPostReviewFlagged, POST_REVIEW_FLAG_VERSION } from '../../domain/events';
import { measureAgainstReference, referenceAmountMinor } from '../../domain/reference-price';
import type { Recheck, VariantKey } from '../ports/first-price-reference';
import {
  referenceFor,
  type GatheredReference,
  type VariantReferenceDependencies,
} from './variant-reference';

export interface RecheckDependencies extends VariantReferenceDependencies {
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

const logger = new Logger('RecheckFirstPrices');

/**
 * The R4 re-check (design section 6, "بازسنجی"): first prices that were accepted with no reference
 * are measured once the Variant has one. Each is measured against the reference without its own
 * seller, by the Offer's regular price in force now; `outside` puts the Offer on the post-publication
 * review list (the price is not held: it already sells) with `pricing.offer-post-review-flagged.v1`. A check is re-checked once.
 *
 * Runs after the seller's write has committed, with what that write already read (no new facade
 * call), in one unit of its own. Best effort: a failure is logged and the pending checks stay
 * pending, to be re-checked by the next first price on the Variant; the seller's write is never
 * failed by it.
 */
export async function recheckFirstPrices(
  deps: RecheckDependencies,
  context: CallContext,
  key: VariantKey,
  gathered: GatheredReference,
  currency: string,
): Promise<number> {
  if (gathered.kind !== 'gathered') return 0;
  const { market } = context;
  try {
    const done = await deps.unitOfWork.run(market, async () => {
      const pending = await deps.reference.checks.pendingRechecks(market, key);
      let count = 0;
      for (const check of pending) {
        const reference = referenceFor(gathered, check.sellerId);
        if (reference.kind !== 'reference') continue;
        const price = gathered.prices.find((p) => p.seriesId === check.seriesId);
        // No price in force (rejected, or the series retired): nothing to measure yet.
        if (price === undefined) continue;
        const verdict = measureAgainstReference(
          price.amountMinor,
          reference.reference,
          reference.bandPercent,
        );
        const recheck: Recheck = {
          recordId: check.recordId,
          outcome: verdict.kind === 'within' ? 'within' : 'outside',
          referenceAmountMinor: referenceAmountMinor(reference.reference),
          amountMinor: price.amountMinor,
          at: deps.clock.now(),
        };
        if (!(await deps.reference.checks.markRechecked(market, recheck))) continue;
        await deps.audit.record(
          context,
          FirstPriceRechecked.entry(check.seriesId, {
            after: {
              offerId: check.offerId,
              variantId: check.variantId,
              amount: money(price.amountMinor, currency),
              outcome: recheck.outcome,
              referenceAmount: money(recheck.referenceAmountMinor, currency),
              businesses: reference.reference.businesses,
              bandPercent: reference.bandPercent,
            },
          }),
        );
        if (recheck.outcome === 'outside') {
          // The Offer goes on the post-publication review list (catalog, through pricing's subscriber).
          await deps.outbox.append(context, [
            OfferPostReviewFlagged.record({
              aggregateId: check.recordId,
              aggregateVersion: POST_REVIEW_FLAG_VERSION.recheck,
              occurredAt: recheck.at,
              payload: {
                offerId: check.offerId,
                productId: key.productId,
                sellerId: check.sellerId,
                recordId: check.recordId,
                reason: 'recheck-outside',
              },
            }),
          ]);
        }
        count += 1;
      }
      return ok(count);
    });
    return done.ok ? done.value : 0;
  } catch (error) {
    logger.warn({
      msg: 'pricing.first-price.recheck-failed',
      variantId: key.variantId,
      error: error instanceof Error ? error.name : 'unknown',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return 0;
  }
}
