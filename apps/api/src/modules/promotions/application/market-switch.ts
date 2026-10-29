import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { PromotionsDependencies } from './promotions-dependencies';
import type { PromotionsSettings } from './ports/promotions-policy';

export type SwitchFailure =
  { readonly code: 'promotions.disabled' } | { readonly code: 'promotions.unavailable' };

/**
 * The Market's promotions settings while promotions are on. No settings in Market config is
 * `promotions.unavailable` (fail closed); a Market with no switch row, or `off`, is
 * `promotions.disabled`. Reads the switch in its own read-only unit, so call it before a
 * read-write unit of the use case opens, never inside one.
 */
export async function activeSettings(
  deps: PromotionsDependencies,
  context: CallContext,
): Promise<Result<PromotionsSettings, SwitchFailure>> {
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'promotions.unavailable' });
  const row = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.settings.find(context.market)),
    { readOnly: true },
  );
  // A switch that cannot be read is not "off": fail closed as unavailable (503), so an outage is
  // not mistaken for the Market's choice.
  if (!row.ok) return err({ code: 'promotions.unavailable' });
  if (row.value === null || row.value.status !== 'active') {
    return err({ code: 'promotions.disabled' });
  }
  return ok(settings);
}

/** Inside an open unit: whether the switch is still on (the write re-checks it). */
export async function isStillActive(
  deps: PromotionsDependencies,
  context: CallContext,
): Promise<boolean> {
  const row = await deps.settings.find(context.market);
  return row !== null && row.status === 'active';
}
