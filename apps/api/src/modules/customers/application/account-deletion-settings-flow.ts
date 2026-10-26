import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  DEFAULT_ACCOUNT_DELETION_SETTINGS,
  parseAccountDeletionSettings,
  parseChangeReason,
  sameSettings,
  type AccountDeletionSettings,
  type FieldError,
} from '../domain/account-deletion-settings';
import { AccountDeletionSettingsChanged } from '../domain/audit';
import { AccountDeletionSettingsChangedEvent } from '../domain/events';
import type { CustomersDependencies } from './customers-dependencies';
import type { AccountDeletionSettingsRepository } from './ports/account-deletion-settings.repository';

export type AccountDeletionSettingsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] }
  /** Another admin changed the setting first; the screen reloads and tries again. */
  | { readonly code: 'customers.conflict' };

/** Account deletion is switched off in this Market (package 2 maps it to HTTP 403). */
export interface AccountDeletionDisabled {
  readonly code: 'customers.account-deletion-disabled';
}

/** What the admin screen reads. */
export interface AccountDeletionSettingsView {
  /** 0 while the built-in defaults are in force. */
  readonly version: number;
  readonly settings: AccountDeletionSettings;
}

/** What the buyer's own screens read: the one fact and the one number they need. */
export interface AccountDeletionAvailability {
  readonly canDeleteAccount: boolean;
  readonly waitingPeriodDays: number;
}

const isAdmin = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

async function current(
  settings: AccountDeletionSettingsRepository,
  market: MarketContext,
): Promise<AccountDeletionSettingsView> {
  const latest = await settings.latest(market);
  return latest === null
    ? { version: 0, settings: DEFAULT_ACCOUNT_DELETION_SETTINGS }
    : { version: latest.version, settings: latest.settings };
}

const snapshot = (view: AccountDeletionSettingsView) => ({
  version: view.version,
  enabled: view.settings.enabled,
  waitingPeriodDays: view.settings.waitingPeriodDays,
});

/** The setting in force: the newest admin version, else the built-in defaults. */
export async function viewAccountDeletionSettings(
  deps: CustomersDependencies,
  context: CallContext,
): Promise<Result<AccountDeletionSettingsView, AccountDeletionSettingsFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  return deps.unitOfWork.run<AccountDeletionSettingsView, AccountDeletionSettingsFailure>(
    context.market,
    async () => ok(await current(deps.accountDeletionSettings, context.market)),
    { readOnly: true },
  );
}

/**
 * An admin replaces the setting from the version they saw, with a reason. Each change is a new
 * version in the insert-only history (with the reason), an audit row and an outbox event, all in
 * one unit.
 */
export async function setAccountDeletionSettings(
  deps: CustomersDependencies,
  context: CallContext,
  input: {
    readonly settings: unknown;
    readonly expectedVersion: unknown;
    readonly reason: unknown;
  },
): Promise<Result<AccountDeletionSettingsView, AccountDeletionSettingsFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const expected = input?.expectedVersion;
  const fields: FieldError[] = [];
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) {
    fields.push({ path: 'expectedVersion', code: 'range' });
  }
  const parsed = parseAccountDeletionSettings(input?.settings);
  if (!parsed.ok) fields.push(...parsed.error);
  const reason = parseChangeReason(input?.reason);
  if (!reason.ok) fields.push(reason.error);
  if (fields.length > 0 || !parsed.ok || !reason.ok) {
    return err({ code: 'validation.failed', fields });
  }
  const next = parsed.value;

  const now = deps.clock.now();
  return deps.unitOfWork.run<AccountDeletionSettingsView, AccountDeletionSettingsFailure>(
    context.market,
    async () => {
      const before = await current(deps.accountDeletionSettings, context.market);
      // The screen saved from an older version: another admin changed the setting meanwhile.
      if (expected !== before.version) return err({ code: 'customers.conflict' } as const);
      // The same values again change nothing: no new version, no audit row, no event.
      if (sameSettings(before.settings, next)) return ok(before);

      const version = before.version + 1;
      const written = await deps.accountDeletionSettings.append(context.market, {
        version,
        settings: next,
        changedAt: now,
        changedBy: actor.accountId,
        reason: reason.value,
      });
      if (!written) return err({ code: 'customers.conflict' } as const);
      const after: AccountDeletionSettingsView = { version, settings: next };
      await deps.audit.record(
        context,
        AccountDeletionSettingsChanged.entry('account-deletion-settings', {
          before: snapshot(before),
          after: snapshot(after),
        }),
      );
      await deps.outbox.append(context, [
        AccountDeletionSettingsChangedEvent.record({
          aggregateId: deps.ids.next<'AccountDeletionSettings'>(),
          aggregateVersion: version,
          occurredAt: now,
          payload: {
            previousEnabled: before.settings.enabled,
            enabled: next.enabled,
            previousWaitingPeriodDays: before.settings.waitingPeriodDays,
            waitingPeriodDays: next.waitingPeriodDays,
          },
        }),
      ]);
      return ok(after);
    },
  );
}

/** What a signed-in buyer may know: whether deleting is on, and how long a request waits. */
export async function viewAccountDeletionAvailability(
  deps: CustomersDependencies,
  context: CallContext,
): Promise<Result<AccountDeletionAvailability, never>> {
  return deps.unitOfWork.run<AccountDeletionAvailability, never>(
    context.market,
    async () => {
      const { settings } = await current(deps.accountDeletionSettings, context.market);
      return ok({
        canDeleteAccount: settings.enabled,
        waitingPeriodDays: settings.waitingPeriodDays,
      });
    },
    { readOnly: true },
  );
}

/**
 * The guard package 2's deletion request calls first, inside its own unit of work: refuses with
 * `customers.account-deletion-disabled` (HTTP 403) when the Market has switched deletion off,
 * else answers the waiting period in force. The Market comes from the caller's context, never
 * from the request. A request already pending keeps running when the setting is switched off:
 * only starting a new one is guarded.
 */
export async function assertAccountDeletionAllowed(
  settings: AccountDeletionSettingsRepository,
  market: MarketContext,
): Promise<Result<{ readonly waitingPeriodDays: number }, AccountDeletionDisabled>> {
  const { settings: inForce } = await current(settings, market);
  if (!inForce.enabled) return err({ code: 'customers.account-deletion-disabled' });
  return ok({ waitingPeriodDays: inForce.waitingPeriodDays });
}
