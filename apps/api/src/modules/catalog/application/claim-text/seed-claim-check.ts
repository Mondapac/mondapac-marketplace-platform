import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CheckClaimText, CheckedText } from './check-claim-text.service';

/** A seed that cannot be applied: the code, and the places (never the texts) that were refused. */
export interface SeedClaimRefusal {
  readonly code: 'seed.claim-text-refused' | 'seed.claim-text-unavailable';
  readonly places: readonly { readonly field: string; readonly ref: string | null }[];
}

/**
 * The claim-text check of checked-in seed data at apply time (catalog design 7.2; ADR-0031
 * decision 3): every name, slug and option label, in every locale, goes through the check as the
 * system actor, before anything is written. A match, a hidden character or an unavailable check
 * refuses the whole run, so a claim word written into seed data fails the deploy step loudly
 * and a check that cannot answer never lets a seed through. It runs outside any unit of work.
 */
export async function checkSeedTexts(
  check: CheckClaimText,
  policy: CatalogMarketPolicy,
  context: CallContext,
  texts: readonly CheckedText[],
): Promise<Result<void, SeedClaimRefusal>> {
  if (texts.length === 0) return ok(undefined);
  try {
    policy.locales(context.market);
  } catch {
    return err({ code: 'seed.claim-text-unavailable', places: [] });
  }
  const verdicts = await check.executeAsSystem(context, texts);
  if (!verdicts.ok) return err({ code: 'seed.claim-text-unavailable', places: [] });
  const bad = verdicts.value.filter((verdict) => verdict.code !== 'clean');
  if (bad.length === 0) return ok(undefined);
  const places = bad.map(({ field, ref }) => ({ field, ref }));
  return err({
    code: bad.every((verdict) => verdict.code === 'claim-text.check-unavailable')
      ? 'seed.claim-text-unavailable'
      : 'seed.claim-text-refused',
    places,
  });
}
