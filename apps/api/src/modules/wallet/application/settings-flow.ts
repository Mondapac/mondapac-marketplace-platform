import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { ChangeScope, LastChanged } from '../../../platform/audit/change-trail';
import type { StepUpRefusal } from '../../../platform/authz';
import { TransactionConflictError } from '../../../platform/unit-of-work/errors';
import { WALLET_SETTINGS_CHANGE_STEP_UP } from '../contracts/step-up';
import { WalletStatusChanged, WalletStatusReverted } from '../domain/audit';
import type { RecordedRequest, RecordFailure } from '../../system-requests';
import {
  WALLET_REVIEW_AREA,
  WALLET_STATUS_SUBJECT_KIND,
  WALLET_SUBJECT_REF,
} from './wallet-review';
import {
  isStatusReason,
  isWalletStatus,
  needsReason,
  type WalletStatus,
  type WalletStatusReason,
} from '../domain/wallet-status';
import type { WalletDependencies } from './wallet-dependencies';

// The wallet switch of a Market (owner decisions of 2026-10-25): an admin moves it between off,
// active, paused and frozen. The switch never deletes or zeroes a balance or a lot. Going back to
// `off` is refused once the Market has any journal (use paused). The change is refused in an acting-as session, is audited with before and after, and is idempotent:
// asking for the state the Market is already in changes nothing and writes no audit row. A change
// spends a fresh two-step proof of the admin's session for `wallet.settings.change` (issue #491,
// closes M3; Hassan L1, L2): the proof is taken in the same unit as the save, so it serves one
// change only, and no fresh proof left at that moment means the unit commits nothing. The route
// guard checks the same proof (read-only) before the body is read; it spends nothing.
// Versioning (settings S4): the request carries `expectedVersion`; the unit compares it to the
// locked row before anything else is decided or spent, so a stale save is a 409
// `wallet.settings-conflict` that keeps the proof. No row reads as version 0.

const LOCK_TIMEOUT_MS = 3000;

export type SettingsFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'wallet.cannot-turn-off-with-history' }
  /** Journals in flight held the switch for too long (lock timeout); try again. */
  | { readonly code: 'wallet.busy' }
  /**
   * The switch changed since the admin loaded it (`expectedVersion` is not the current one).
   * `lastChanged` is the winning change, null when it cannot be read.
   */
  | { readonly code: 'wallet.settings-conflict'; readonly lastChanged?: LastChanged | null }
  /** The admin has no fresh two-step proof for the switch: verify one, then repeat (issue #491). */
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  /** The admin has no active two-step: set it up first. */
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | RecordFailure;

export interface SettingsView {
  readonly status: WalletStatus;
  readonly reason: WalletStatusReason | null;
  /** Null while the Market has never been switched. */
  readonly updatedAt: Temporal.Instant | null;
  /** 0 while the Market has never been switched; the value to send back as `expectedVersion`. */
  readonly version: number;
}

/** A switch's answer: the System requests review it opened (null when none). */
export interface SettingsChange extends SettingsView {
  readonly request: Pick<RecordedRequest, 'id' | 'number'> | null;
}

/** The wallet page's read model: the switch and the latest change. */
export interface SettingsPage extends SettingsView {
  /** Null while the Market has never been switched. */
  readonly lastChanged: LastChanged | null;
}

/**
 * The audit rows of the wallet switch: the state and the reason are the fields; the step-up proof
 * the change spent is not a setting.
 */
export const WALLET_SETTINGS_CHANGES: ChangeScope = {
  actions: [WalletStatusChanged.action, WalletStatusReverted.action],
  targetId: 'wallet-settings',
  ignoreKeys: ['stepUpSessionId', 'stepUpVerifiedAt', 'requestId'],
};

/** Whether the actor is an acting-as session (Login as Seller): the reserved marker on the actor. */
export function isActingAs(context: CallContext): boolean {
  const actor = context.actor;
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}

const isAdmin = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

export async function viewSettings(
  deps: WalletDependencies,
  context: CallContext,
): Promise<Result<SettingsView, SettingsFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  return deps.unitOfWork.run<SettingsView, SettingsFailure>(
    context.market,
    async () => {
      const row = await deps.settings.find(context.market);
      return ok({
        status: row?.status ?? 'off',
        reason: row?.reason ?? null,
        updatedAt: row?.updatedAt ?? null,
        version: row?.version ?? 0,
      });
    },
    { readOnly: true },
  );
}

/** identity's refusal of the step-up, as the switch answers it; anything else stays closed. */
function stepUpFailure(refusal: StepUpRefusal): SettingsFailure {
  if (
    refusal.code === 'second-factor.required' ||
    refusal.code === 'second-factor.enrolment-required'
  ) {
    return { code: refusal.code, actionKey: refusal.actionKey };
  }
  return { code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied' };
}

export async function setStatus(
  deps: WalletDependencies,
  context: CallContext,
  input: {
    readonly status: unknown;
    readonly reasonCode?: unknown;
    readonly expectedVersion?: unknown;
    /** The admin's note for the System requests review (needed where area money is reviewed). */
    readonly note?: unknown;
  },
): Promise<Result<SettingsChange, SettingsFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAs(context)) {
    return err({ code: 'access.denied' });
  }
  const fields: { path: string; code: string }[] = [];
  const status = input?.status;
  if (!isWalletStatus(status)) fields.push({ path: 'status', code: 'value' });
  const rawReason = input?.reasonCode;
  let reason: WalletStatusReason | null = null;
  if (isWalletStatus(status)) {
    if (needsReason(status)) {
      if (isStatusReason(rawReason)) reason = rawReason;
      else
        fields.push({ path: 'reasonCode', code: rawReason === undefined ? 'required' : 'value' });
    } else if (rawReason !== undefined && rawReason !== null) {
      fields.push({ path: 'reasonCode', code: 'not-allowed' });
    }
  }
  const expected = input?.expectedVersion;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) {
    fields.push({ path: 'expectedVersion', code: expected === undefined ? 'required' : 'value' });
  }
  if (fields.length > 0 || !isWalletStatus(status) || typeof expected !== 'number')
    return err({ code: 'validation.failed', fields });

  const now = deps.clock.now();
  // The change waits for the journals in flight; it gives up after 3 s instead of queueing the
  // whole Market's wallet writes behind it.
  const attempt = () =>
    deps.unitOfWork.run<SettingsChange, SettingsFailure>(
      context.market,
      async () => {
        const before = await deps.settings.findForUpdate(context.market);
        const was = before?.status ?? 'off';
        const currentVersion = before?.version ?? 0;
        // Stale check first, under the row lock and BEFORE the step-up is spent: a stale save
        // answers 409 and the admin's two-step proof stays unspent for the retry.
        if (expected !== currentVersion) return err({ code: 'wallet.settings-conflict' } as const);
        if (was === status) {
          return ok({
            status: was,
            reason: before?.reason ?? null,
            updatedAt: before?.updatedAt ?? null,
            version: currentVersion,
            request: null,
          });
        }
        if (status === 'off' && (await deps.wallet.hasJournals(context.market))) {
          return err({ code: 'wallet.cannot-turn-off-with-history' } as const);
        }
        // The admin step-up, spent here and only here (ADR-0018: authorization in the use case).
        const spent = await deps.stepUp.consume(context, WALLET_SETTINGS_CHANGE_STEP_UP);
        if (!spent.ok) return err(stepUpFailure(spent.error));
        await deps.settings.save(context.market, {
          status,
          reason,
          updatedAt: now,
          updatedBy: actor.accountId,
          version: currentVersion + 1,
        });
        await deps.audit.record(
          context,
          WalletStatusChanged.entry('wallet-settings', {
            before: { status: was, reason: before?.reason ?? null },
            after: {
              status,
              reason,
              stepUpSessionId: spent.value.sessionId,
              stepUpVerifiedAt: spent.value.verifiedAt,
            },
          }),
        );
        // The switch is live; its review opens in the same unit (a refusal rolls it back).
        const review = await deps.review.openReview(context, {
          area: WALLET_REVIEW_AREA,
          subjectKind: WALLET_STATUS_SUBJECT_KIND,
          subjectRef: WALLET_SUBJECT_REF,
          before: { status: was, reason: before?.reason ?? null },
          after: { status, reason },
          note: input.note,
        });
        if (!review.ok) return err(review.error);
        return ok({
          status,
          reason,
          updatedAt: now,
          version: currentVersion + 1,
          request:
            review.value === null ? null : { id: review.value.id, number: review.value.number },
        });
      },
      { lockTimeoutMs: LOCK_TIMEOUT_MS },
    );
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof TransactionConflictError) return err({ code: 'wallet.busy' });
    throw error;
  }
}

/**
 * Restores the wallet switch before a change a reviewer rejected or its author withdrew, in the
 * open unit of that decision (System requests), only while the switch still holds the state after
 * the change. Going back to `off` once the Market has journals is not possible (the wallet moved
 * on): `changed-since`. A new version, audited as `wallet.market-status.reverted`.
 */
export async function revertStatus(
  deps: WalletDependencies,
  context: CallContext,
  request: {
    readonly requestId: Id<'SystemRequest'>;
    readonly before: Readonly<Record<string, unknown>>;
    readonly after: Readonly<Record<string, unknown>>;
  },
): Promise<'reverted' | 'changed-since' | 'gone'> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAs(context)) {
    throw new Error('wallet: a revert needs a signed-in admin acting as themselves');
  }
  const restore = request.before.status;
  const restoreReason = request.before.reason ?? null;
  if (
    !isWalletStatus(restore) ||
    (needsReason(restore) ? !isStatusReason(restoreReason) : restoreReason !== null)
  ) {
    return 'gone';
  }
  const row = await deps.settings.findForUpdate(context.market);
  const current = row?.status ?? 'off';
  const currentReason = row?.reason ?? null;
  if (current !== request.after.status || currentReason !== (request.after.reason ?? null)) {
    return 'changed-since';
  }
  if (restore === 'off' && (await deps.wallet.hasJournals(context.market))) return 'changed-since';
  const version = (row?.version ?? 0) + 1;
  await deps.settings.save(context.market, {
    status: restore,
    reason: restoreReason as WalletStatusReason | null,
    updatedAt: deps.clock.now(),
    updatedBy: actor.accountId,
    version,
  });
  await deps.audit.record(
    context,
    WalletStatusReverted.entry('wallet-settings', {
      before: { status: current, reason: currentReason },
      after: {
        status: restore,
        reason: restoreReason as WalletStatusReason | null,
        requestId: request.requestId,
      },
    }),
  );
  return 'reverted';
}
