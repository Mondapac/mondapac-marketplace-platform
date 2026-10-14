import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import { PayoutSchedulePaused, PayoutScheduleResumed } from '../domain/audit';
import { desiredSchedule, scheduleKey } from '../domain/payout-change';
import type { PaymentsDependencies } from './payments-dependencies';
import type { ConnectedAccountRecord } from './ports/connected-account-store';

/** Accounts looked at per run; the next run takes the rest. */
export const SCHEDULE_BATCH = 25;

export interface ScheduleSyncSummary {
  readonly paused: number;
  readonly resumed: number;
  /** Stripe did not take the write (unavailable or refused): tried again on the next run. */
  readonly problems: readonly {
    readonly sellerId: string;
    readonly code: 'payment.provider-unavailable' | 'payment.provider-rejected';
  }[];
}

export type ScheduleSyncFailure = AccessDenied;

/**
 * `sync-payout-schedules`: the one place that writes a payout schedule to Stripe. Per account it
 * compares what is wanted now (manual while `payouts_paused_until` is in the future, else the
 * Market's own schedule) with what was last applied, writes the difference with an idempotency
 * key of the change (`payout-pause:<id>` / `payout-resume:<id>`), and records the applied state
 * and an audit row only after Stripe accepted it. A Stripe error changes nothing and is tried
 * again on the next run. The event handler never calls Stripe for this: it only moves
 * `payouts_paused_until` and marks a pause that a read found undone. The account is read again
 * just before its write, so a change that arrived since the batch was read is not undone.
 */
export async function syncPayoutSchedules(
  deps: PaymentsDependencies,
  context: CallContext,
): Promise<Result<ScheduleSyncSummary, ScheduleSyncFailure>> {
  const market = context.market;
  const normal = deps.policy.normalPayoutSchedule(market);
  if (normal === null) return ok({ paused: 0, resumed: 0, problems: [] });
  const due = await deps.unitOfWork.run<readonly ConnectedAccountRecord[], never>(
    market,
    async () =>
      ok(await deps.accounts.dueForScheduleSync(market, deps.clock.now(), SCHEDULE_BATCH)),
    { readOnly: true },
  );
  if (!due.ok) return due;
  let paused = 0;
  let resumed = 0;
  const problems: { sellerId: string; code: ScheduleSyncSummary['problems'][number]['code'] }[] =
    [];
  for (const listed of due.value) {
    const fresh = await deps.unitOfWork.run<ConnectedAccountRecord | null, never>(
      market,
      async () => ok(await deps.accounts.find(market, listed.sellerId)),
      { readOnly: true },
    );
    if (!fresh.ok || fresh.value === null) continue;
    const record = fresh.value;
    const wanted = desiredSchedule(record.payoutsPausedUntil, deps.clock.now());
    if (
      record.accountRef === null ||
      record.lastChangeId === null ||
      wanted === (record.payoutScheduleApplied ?? 'normal')
    ) {
      continue;
    }
    const pause = wanted === 'manual';
    const written = await deps.connect.setPayoutSchedule(
      record.accountRef,
      pause ? 'manual' : normal,
      scheduleKey(pause ? 'pause' : 'resume', record.lastChangeId, record.payoutScheduleRevision),
    );
    if (!written.ok) {
      problems.push({ sellerId: record.sellerId, code: written.error.code });
      continue;
    }
    const changeId = record.lastChangeId as Id<'PayoutChange'>;
    const sellerId = record.sellerId as Id<'Seller'>;
    await deps.unitOfWork.run<true, never>(market, async () => {
      const at = deps.clock.now();
      await deps.accounts.markScheduleApplied(market, record.sellerId, wanted, at);
      await deps.audit.record(
        context,
        pause
          ? PayoutSchedulePaused.entry(sellerId, { after: { changeId } })
          : PayoutScheduleResumed.entry(sellerId, { after: { changeId } }),
      );
      return ok(true);
    });
    if (pause) paused += 1;
    else resumed += 1;
  }
  return ok({ paused, resumed, problems });
}
