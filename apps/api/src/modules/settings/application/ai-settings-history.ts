import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { SETTINGS_AI_SETTINGS_REVERT_STEP_UP } from '../contracts/step-up';
import {
  acceptedValue,
  AI_GATEWAY_EMERGENCY_STOP_CODE,
  findDefinition,
} from '../domain/definitions';
import type { AdminNames } from './ports/admin-names';
import type { SettingsDependencies } from './settings-dependencies';
import {
  adminAccountId,
  changeSettings,
  type FieldIssue,
  type SettingChangeView,
  type SettingsFailure,
} from './settings-flow';

/**
 * The most history rows one read answers: the latest changes of one setting. The panel shows them
 * as a plain list with this limit stated; older changes stay in the history table and the audit
 * log. A list this short is not a super list (CLAUDE.md rule 14 applies above 50 rows).
 */
export const HISTORY_LIMIT = 50;

/** One change of a setting's history as an admin reads it (G4d3). */
export interface SettingHistoryView {
  readonly code: string;
  /** The version this change made (1 for the first change). */
  readonly version: number;
  /** The value before the change; null while the default was in force. */
  readonly previousValue: string | null;
  readonly value: string;
  readonly changedAt: Temporal.Instant;
  /** The display name of the admin who made the change; null when unknown. */
  readonly changedBy: string | null;
  /** The admin's reason kept with the change, if any. */
  readonly note: string | null;
  /** Whether this version is the one in force. */
  readonly current: boolean;
}

export interface HistoryInput {
  /** The setting whose changes to read: a code of the page. */
  readonly code?: unknown;
  /** 1 to 50; 50 when absent. */
  readonly limit?: unknown;
}

export interface SettingHistoryDependencies {
  readonly settings: SettingsDependencies;
  readonly names: AdminNames;
}

/**
 * The latest changes of one setting of the caller's Market (one of `allowedCodes`, the codes of
 * the page the caller's view key covers), newest first, at most `limit` (1 to
 * {@link HISTORY_LIMIT}, default {@link HISTORY_LIMIT}). Read in a read-only unit; the Market is
 * the caller's, so no admin reads another Market's history.
 */
export async function viewSettingHistory(
  deps: SettingHistoryDependencies,
  context: CallContext,
  allowedCodes: readonly string[],
  input: HistoryInput,
): Promise<Result<readonly SettingHistoryView[], SettingsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const fields: FieldIssue[] = [];
  const code =
    typeof input?.code === 'string' && allowedCodes.includes(input.code) ? input.code : null;
  if (code === null) fields.push({ path: 'code', code: 'value' });
  const limit = input?.limit === undefined ? HISTORY_LIMIT : input.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > HISTORY_LIMIT) {
    fields.push({ path: 'limit', code: 'range' });
  }
  if (code === null || fields.length > 0) return err({ code: 'validation.failed', fields });
  const read = await deps.settings.unitOfWork.run(
    context.market,
    async () => {
      const [rows, current] = await Promise.all([
        deps.settings.settings.history(context.market, code, limit as number),
        deps.settings.settings.find(context.market, code),
      ]);
      return ok({ rows, current });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  const { rows, current } = read.value;
  const names = await deps.names.namesOf(
    context,
    rows.map((row) => row.changedBy),
  );
  return ok(
    rows.map((row) => ({
      code: row.code,
      version: row.version,
      previousValue: row.previousValue,
      value: row.value,
      changedAt: row.changedAt,
      changedBy: names.get(row.changedBy) ?? null,
      note: row.note,
      current: row.version === (current?.version ?? 0),
    })),
  );
}

export interface RevertInput {
  /** The setting to revert (a code of the page). */
  readonly code?: unknown;
  /** The version whose value comes back; 0 is the default (before any change). */
  readonly version?: unknown;
  /** The version in force the admin saw: a stale one is `settings.conflict`. */
  readonly expectedVersion?: unknown;
  /** The admin's note: required for the emergency stop, else only where the area is reviewed. */
  readonly note?: unknown;
}

/** The longest note a revert takes (the settings note limit). */
const MAX_NOTE = 500;

/**
 * A panel revert of one AI setting to the value of an earlier version (G4d3, design section 8):
 * a forward change through {@link changeSettings}, so it gets the same version check, the same
 * check of the page as it would stand (`checkResult`: the caps' pair, the model lists' catalogue
 * checks), history, audit and review as any change. Every revert spends the admin's fresh two-step
 * code (`settings.ai-settings.revert`), whatever it restores: this is the only revert that may
 * allow more AI, while the review reverter never does (`loosensAi`). A version that is not in the
 * history, or a value its definition no longer allows, is `validation.failed` on `version`; the
 * value already in force is `validation.failed` on `version` with the code `same`, so it spends no
 * proof.
 */
export async function revertAiSetting(
  deps: SettingsDependencies,
  context: CallContext,
  /** The codes of the page the caller's manage key covers. */
  allowedCodes: readonly string[],
  input: RevertInput,
  checkResult?: (
    values: ReadonlyMap<string, string>,
    changed: ReadonlySet<string>,
  ) => readonly FieldIssue[],
): Promise<Result<SettingChangeView, SettingsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const definition =
    typeof input?.code === 'string' && allowedCodes.includes(input.code)
      ? findDefinition(input.code)
      : null;
  const fields: FieldIssue[] = [];
  if (definition === null) fields.push({ path: 'code', code: 'value' });
  const { version, expectedVersion } = input ?? {};
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    fields.push({ path: 'version', code: 'type' });
  }
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) {
    fields.push({ path: 'expectedVersion', code: 'type' });
  }
  const note = typeof input?.note === 'string' ? input.note.trim() : '';
  if (definition?.code === AI_GATEWAY_EMERGENCY_STOP_CODE && note.length === 0) {
    // The stop always carries a reason, as its own change does.
    fields.push({ path: 'note', code: 'required' });
  }
  if (note.length > MAX_NOTE) fields.push({ path: 'note', code: 'too-long' });
  if (definition === null || fields.length > 0) return err({ code: 'validation.failed', fields });
  // History rows are insert-only. The value in force may still change before the change's unit;
  // changeSettings then answers the version conflict.
  const target = await deps.unitOfWork.run<
    { readonly value: string | null; readonly current: string },
    SettingsFailure
  >(
    context.market,
    async () => {
      const row = await deps.settings.find(context.market, definition.code);
      const current = row?.value ?? definition.defaultValue;
      if (version === 0) return ok({ value: definition.defaultValue, current });
      const history = await deps.settings.historyVersion(
        context.market,
        definition.code,
        version as number,
      );
      return ok({
        value: history === null ? null : acceptedValue(definition, history.value),
        current,
      });
    },
    { readOnly: true },
  );
  if (!target.ok) return target;
  if (target.value.value === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'version', code: 'value' }] });
  }
  // The value already in force: nothing to restore, so no proof is spent (Mohammad, PR 1375).
  if (target.value.value === target.value.current) {
    return err({ code: 'validation.failed', fields: [{ path: 'version', code: 'same' }] });
  }
  const changed = await changeSettings(
    deps,
    context,
    allowedCodes,
    {
      changes: [{ code: definition.code, value: target.value.value, expectedVersion }],
      ...(note.length > 0 ? { note } : {}),
    },
    { action: SETTINGS_AI_SETTINGS_REVERT_STEP_UP },
    checkResult,
  );
  if (!changed.ok) return changed;
  return ok(changed.value[0]!);
}
