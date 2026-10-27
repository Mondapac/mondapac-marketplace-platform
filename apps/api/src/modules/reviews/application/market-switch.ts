import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ReviewsSettings } from './ports/reviews-policy';
import type { ReviewsDependencies } from './reviews-dependencies';

/**
 * The Market's review settings while reviews are on. No settings in Market config is
 * `reviews.unavailable` (fail closed); a Market with no switch row, or `off`, is
 * `reviews.disabled`. Reads the switch in its own read-only unit, so call it before a
 * read-write unit of the use case opens, never inside one.
 */
export async function activeSettings(
  deps: ReviewsDependencies,
  context: CallContext,
): Promise<
  Result<
    ReviewsSettings,
    { readonly code: 'reviews.disabled' } | { readonly code: 'reviews.unavailable' }
  >
> {
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'reviews.unavailable' });
  const row = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.settings.find(context.market)),
    { readOnly: true },
  );
  // A switch that cannot be read is not "off": fail closed as unavailable (503), so an outage is
  // not mistaken for the Market's choice.
  if (!row.ok) return err({ code: 'reviews.unavailable' });
  if (row.value === null || row.value.status !== 'active') {
    return err({ code: 'reviews.disabled' });
  }
  return ok(settings);
}

/** Inside an open unit: whether the switch is still on (the write re-checks it). */
export async function isStillActive(
  deps: ReviewsDependencies,
  context: CallContext,
): Promise<boolean> {
  const row = await deps.settings.find(context.market);
  return row !== null && row.status === 'active';
}
