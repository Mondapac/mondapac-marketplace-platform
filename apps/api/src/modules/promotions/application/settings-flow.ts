import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { PromotionsStatusChanged } from '../domain/audit';
import { isPromotionsStatus, type PromotionsStatus } from '../domain/market-status';
import { adminAccountId } from './caller';
import type { FieldIssue } from './failures';
import type { PromotionsDependencies } from './promotions-dependencies';

// The promotions switch of a Market: an admin moves it between off and active. Turning it off
// deletes nothing: use cases refuse with `promotions.disabled`, the calculation returns no
// discount, and the rows stay. The change is refused in an acting-as session, is audited with
// before and after, and is idempotent: asking for the state the Market is already in changes
// nothing and writes no audit row.

export type SettingsFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'access.denied' };

export interface SettingsView {
  readonly status: PromotionsStatus;
  /** Null while the Market has never been switched. */
  readonly updatedAt: Temporal.Instant | null;
}

export async function viewSettings(
  deps: PromotionsDependencies,
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
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly status?: unknown },
): Promise<Result<SettingsView, SettingsFailure>> {
  const adminId = adminAccountId(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const status = input?.status;
  if (!isPromotionsStatus(status)) {
    return err({ code: 'validation.failed', fields: [{ path: 'status', code: 'value' }] });
  }
  const now = deps.clock.now();
  return deps.unitOfWork.run<SettingsView, SettingsFailure>(context.market, async () => {
    const before = await deps.settings.find(context.market);
    const was = before?.status ?? 'off';
    if (was === status) return ok({ status: was, updatedAt: before?.updatedAt ?? null });
    await deps.settings.save(context.market, { status, updatedAt: now, updatedBy: adminId });
    await deps.audit.record(
      context,
      PromotionsStatusChanged.entry('promotions-settings', {
        before: { status: was },
        after: { status },
      }),
    );
    return ok({ status, updatedAt: now });
  });
}
