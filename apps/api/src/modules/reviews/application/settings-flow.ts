import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { ReviewsStatusChanged } from '../domain/audit';
import { isReviewsStatus, type ReviewsStatus } from '../domain/market-status';
import { adminAccountId } from './caller';
import type { FieldIssue } from './failures';
import type { ReviewsDependencies } from './reviews-dependencies';

// The reviews switch of a Market (owner decision of the package): an admin moves it between off
// and active. Turning it off deletes nothing: reads and writes answer `reviews.disabled` and the
// rows stay. The change is refused in an acting-as session, is audited with before and after, and
// is idempotent: asking for the state the Market is already in changes nothing and writes no audit
// row. (Step-up: identity has no such primitive for admins today; same known gap as wallet.)

export type SettingsFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'access.denied' };

export interface SettingsView {
  readonly status: ReviewsStatus;
  /** Null while the Market has never been switched. */
  readonly updatedAt: Temporal.Instant | null;
}

export async function viewSettings(
  deps: ReviewsDependencies,
  context: CallContext,
): Promise<Result<SettingsView, SettingsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  return deps.unitOfWork.run<SettingsView, SettingsFailure>(
    context.market,
    async () => {
      const row = await deps.settings.find(context.market);
      return ok({ status: row?.status ?? 'off', updatedAt: row?.updatedAt ?? null });
    },
    { readOnly: true },
  );
}

export async function setStatus(
  deps: ReviewsDependencies,
  context: CallContext,
  input: { readonly status?: unknown },
): Promise<Result<SettingsView, SettingsFailure>> {
  const adminId = adminAccountId(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const status = input?.status;
  if (!isReviewsStatus(status)) {
    return err({ code: 'validation.failed', fields: [{ path: 'status', code: 'value' }] });
  }
  const now = deps.clock.now();
  return deps.unitOfWork.run<SettingsView, SettingsFailure>(context.market, async () => {
    const before = await deps.settings.find(context.market);
    const was = before?.status ?? 'off';
    if (was === status) {
      return ok({ status: was, updatedAt: before?.updatedAt ?? null });
    }
    await deps.settings.save(context.market, { status, updatedAt: now, updatedBy: adminId });
    await deps.audit.record(
      context,
      ReviewsStatusChanged.entry('reviews-settings', {
        before: { status: was },
        after: { status },
      }),
    );
    return ok({ status, updatedAt: now });
  });
}
