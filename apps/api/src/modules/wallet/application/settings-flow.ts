import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { TransactionConflictError } from '../../../platform/unit-of-work/errors';
import { WALLET_SETTINGS_CHANGE_STEP_UP } from '../contracts/step-up';
import { WalletStatusChanged } from '../domain/audit';
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
// asking for the state the Market is already in changes nothing and writes no audit row. It
// needs a fresh two-step proof of the admin's session for `wallet.settings.change` (issue #491,
// closes M3), asked of identity here as well as by the route guard (ADR-0018).

const LOCK_TIMEOUT_MS = 3000;

export type SettingsFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'wallet.cannot-turn-off-with-history' }
  /** Journals in flight held the switch for too long (lock timeout); try again. */
  | { readonly code: 'wallet.busy' }
  /** The admin has no fresh two-step proof for the switch: verify one, then repeat (issue #491). */
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  /** The admin has no active two-step: set it up first. */
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' };

export interface SettingsView {
  readonly status: WalletStatus;
  readonly reason: WalletStatusReason | null;
  /** Null while the Market has never been switched. */
  readonly updatedAt: Temporal.Instant | null;
}

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
      });
    },
    { readOnly: true },
  );
}

export async function setStatus(
  deps: WalletDependencies,
  context: CallContext,
  input: { readonly status: unknown; readonly reasonCode?: unknown },
): Promise<Result<SettingsView, SettingsFailure>> {
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
  if (fields.length > 0 || !isWalletStatus(status))
    return err({ code: 'validation.failed', fields });

  // The admin step-up, before any change (issue #491). Any other refusal from identity keeps the
  // switch closed.
  const stepUp = await deps.identity.requireStepUp(context, WALLET_SETTINGS_CHANGE_STEP_UP);
  if (!stepUp.ok) {
    const refusal = stepUp.error;
    if (
      refusal.code === 'second-factor.required' ||
      refusal.code === 'second-factor.enrolment-required'
    ) {
      return err({ code: refusal.code, actionKey: refusal.actionKey });
    }
    return err({
      code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied',
    });
  }

  const now = deps.clock.now();
  // The change waits for the journals in flight; it gives up after 3 s instead of queueing the
  // whole Market's wallet writes behind it.
  const attempt = () =>
    deps.unitOfWork.run<SettingsView, SettingsFailure>(
      context.market,
      async () => {
        const before = await deps.settings.findForUpdate(context.market);
        const was = before?.status ?? 'off';
        if (was === status) {
          return ok({
            status: was,
            reason: before?.reason ?? null,
            updatedAt: before?.updatedAt ?? null,
          });
        }
        if (status === 'off' && (await deps.wallet.hasJournals(context.market))) {
          return err({ code: 'wallet.cannot-turn-off-with-history' } as const);
        }
        await deps.settings.save(context.market, {
          status,
          reason,
          updatedAt: now,
          updatedBy: actor.accountId,
        });
        await deps.audit.record(
          context,
          WalletStatusChanged.entry('wallet-settings', {
            before: { status: was, reason: before?.reason ?? null },
            after: { status, reason },
          }),
        );
        return ok({ status, reason, updatedAt: now });
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
