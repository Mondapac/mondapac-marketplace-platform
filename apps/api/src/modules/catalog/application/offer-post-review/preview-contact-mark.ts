import type { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PREVIEW_CONTACT_MARK } from '../../domain/rate-limits';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterWindows } from '../ports/rate-counter-windows';

export interface PreviewContactMarkDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly counterWindows: RateCounterWindows;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

/**
 * Before a unit that may put new text live at once (the submit, and the edit of a live Offer):
 * whether the seller's {@link PREVIEW_CONTACT_MARK} window is open, so that write goes on the
 * post-publication review list with `preview-contact-text` (slice 7b; security M1 and N1 of PR
 * 1376). A read that fails counts as open (fail closed: one more post-publication review, never
 * one less); the log line holds a code only.
 */
export async function previewedContact(
  deps: PreviewContactMarkDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
  logger: Logger,
): Promise<boolean> {
  const { market } = context;
  try {
    const counter = {
      limit: PREVIEW_CONTACT_MARK,
      keyHash: deps.counterKeys.keyOf(market, PREVIEW_CONTACT_MARK.kind, sellerId),
    };
    const now = deps.clock.now();
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.counterWindows.isOpen(market, counter, now)),
      { readOnly: true },
    );
    if (read.ok) return read.value;
  } catch {
    // Logged below, a code only.
  }
  logger.warn({
    msg: 'catalog.preview-mark-unreadable',
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return true;
}
