import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { FieldIssue } from './failures';
import type { ReviewsDependencies } from './reviews-dependencies';

// The system's two jobs in reviews: rebuild the summaries from the source tables (worker), and
// drop the author link of a deleted account (owner decision N11).

export type MaintenanceFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'reviews.unavailable' };

/** Subjects per unit: short transactions, so the repair never blocks the write path. */
export const REBUILD_BATCH = 100;

/**
 * Repairs every summary of the Market from the published reviews and ratings; a no-op while
 * reviews are off. The subjects are listed in one read-only unit, then rebuilt in batches, each
 * in its own short unit that writes only the rows whose numbers changed. Safe to run twice and
 * concurrently: each batch recomputes from the source rows and writes the same numbers.
 */
export async function rebuildSummaries(
  deps: ReviewsDependencies,
  context: CallContext,
): Promise<Result<{ readonly rebuilt: number }, MaintenanceFailure>> {
  const now = deps.clock.now();
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'reviews.unavailable' });
  const listed = await deps.unitOfWork.run(
    context.market,
    async () => {
      const row = await deps.settings.find(context.market);
      if (row === null || row.status !== 'active') return ok(null);
      return ok(await deps.reviews.summarySubjects(context.market));
    },
    { readOnly: true },
  );
  if (!listed.ok) return err({ code: 'reviews.unavailable' });
  if (listed.value === null) return ok({ rebuilt: 0 });

  const subjects = [
    ...listed.value.products.map((id) => ({ kind: 'product' as const, id })),
    ...listed.value.sellers.map((id) => ({ kind: 'seller' as const, id })),
  ];
  let rebuilt = 0;
  for (let from = 0; from < subjects.length; from += REBUILD_BATCH) {
    const batch = subjects.slice(from, from + REBUILD_BATCH);
    const done = await deps.unitOfWork.run<number, MaintenanceFailure>(context.market, async () =>
      ok(
        await deps.reviews.rebuildSummaries(
          context.market,
          {
            products: batch.flatMap((s) => (s.kind === 'product' ? [s.id] : [])),
            sellers: batch.flatMap((s) => (s.kind === 'seller' ? [s.id] : [])),
          },
          now,
        ),
      ),
    );
    if (!done.ok) return done;
    rebuilt += done.value;
  }
  return ok({ rebuilt });
}

/**
 * Detaches a deleted account from its reviews and ratings: the account id goes to null, the
 * rating and the text stay, and the review shows as "Former customer". It works whether reviews
 * are on or off: a person's wish to be forgotten does not wait for a switch. Idempotent.
 */
export async function detachAuthor(
  deps: ReviewsDependencies,
  context: CallContext,
  input: { readonly accountId?: unknown },
): Promise<Result<{ readonly reviews: number; readonly ratings: number }, MaintenanceFailure>> {
  const accountId =
    typeof input?.accountId === 'string' ? parseId<'Account'>(input.accountId) : null;
  if (accountId === null || !accountId.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'accountId', code: 'format' }] });
  }
  return deps.unitOfWork.run<
    { readonly reviews: number; readonly ratings: number },
    MaintenanceFailure
  >(context.market, async () =>
    ok(await deps.reviews.detachAccount(context.market, accountId.value)),
  );
}
