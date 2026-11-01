import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { MarketSettingChanged } from '../domain/audit';
import { findDefinition, SETTING_DEFINITIONS } from '../domain/definitions';
import type { SettingsDependencies } from './settings-dependencies';

// Admin-editable Market settings (ADR-0026). A change is refused in an acting-as session, checks
// the version the admin saw (a stale edit is refused), writes the value and a history row in one
// unit, and is audited. Asking for the value already in force changes nothing.

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
}

export type SettingsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldIssue[] }
  /** Another admin changed the setting first; the screen reloads and tries again. */
  | { readonly code: 'settings.conflict' };

export interface SettingView {
  readonly code: string;
  readonly value: string;
  /** 0 while the default is in force. */
  readonly version: number;
  readonly updatedAt: Temporal.Instant | null;
}

const isActingAs = (context: CallContext): boolean => {
  const actor = context.actor;
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
};

/** An admin session that is not acting as someone else. */
function adminAccountId(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return null;
  return isActingAs(context) ? null : actor.accountId;
}

/** Every setting of the Market with the value in force. */
export async function viewSettings(
  deps: SettingsDependencies,
  context: CallContext,
): Promise<Result<readonly SettingView[], SettingsFailure>> {
  return deps.unitOfWork.run<readonly SettingView[], SettingsFailure>(
    context.market,
    async () => {
      const rows = await deps.settings.list(context.market);
      return ok(
        SETTING_DEFINITIONS.map((definition) => {
          const row = rows.find((candidate) => candidate.code === definition.code);
          return {
            code: definition.code,
            value: row?.value ?? definition.defaultValue,
            version: row?.version ?? 0,
            updatedAt: row?.updatedAt ?? null,
          };
        }),
      );
    },
    { readOnly: true },
  );
}

/**
 * One setting's value for a panel to read. A store that cannot be read answers the setting's safe
 * value, never an error and never another Market's value.
 */
export async function readSettingValue(
  deps: SettingsDependencies,
  context: CallContext,
  code: string,
): Promise<string | null> {
  const definition = findDefinition(code);
  if (definition === null) return null;
  try {
    const read = await deps.unitOfWork.run(
      context.market,
      async () => ok(await deps.settings.find(context.market, code)),
      { readOnly: true },
    );
    if (!read.ok) return definition.safeValue;
    return read.value?.value ?? definition.defaultValue;
  } catch {
    // An unreadable store is not the Market's choice: answer the safe value (ADR-0026 decision 5).
    return definition.safeValue;
  }
}

export async function changeSetting(
  deps: SettingsDependencies,
  context: CallContext,
  input: { readonly code?: unknown; readonly value?: unknown; readonly expectedVersion?: unknown },
): Promise<Result<SettingView, SettingsFailure>> {
  const adminId = adminAccountId(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const definition = findDefinition(input?.code);
  if (definition === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'code', code: 'value' }] });
  }
  const { value, expectedVersion } = input;
  const fields: FieldIssue[] = [];
  if (typeof value !== 'string' || !definition.values.includes(value)) {
    fields.push({ path: 'value', code: 'value' });
  }
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) {
    fields.push({ path: 'expectedVersion', code: 'type' });
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  const next = value as string;
  const seen = expectedVersion as number;
  const now = deps.clock.now();
  return deps.unitOfWork.run<SettingView, SettingsFailure>(context.market, async () => {
    const before = await deps.settings.find(context.market, definition.code);
    const currentVersion = before?.version ?? 0;
    if (currentVersion !== seen) return err({ code: 'settings.conflict' });
    const was = before?.value ?? definition.defaultValue;
    if (was === next) {
      return ok({
        code: definition.code,
        value: was,
        version: currentVersion,
        updatedAt: before?.updatedAt ?? null,
      });
    }
    const version = currentVersion + 1;
    const applied = await deps.settings.apply(context.market, {
      code: definition.code,
      value: next,
      previousValue: before?.value ?? null,
      version,
      changedAt: now,
      changedBy: adminId,
    });
    if (!applied) return err({ code: 'settings.conflict' });
    await deps.audit.record(
      context,
      MarketSettingChanged.entry(definition.code as 'list-paging', {
        before: { value: was as 'pages' | 'prev-next' },
        after: { value: next as 'pages' | 'prev-next', version },
      }),
    );
    return ok({ code: definition.code, value: next, version, updatedAt: now });
  });
}
