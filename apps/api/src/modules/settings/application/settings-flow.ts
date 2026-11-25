import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry } from '@mondapac/shared-kernel';
import {
  MarketNumberSettingChanged,
  MarketSettingChanged,
  MonthlyRevenueTargetChanged,
  type NUMBER_SETTING_TARGET_IDS,
  type SETTING_TARGET_IDS,
} from '../domain/audit';
import {
  acceptedValue,
  findDefinition,
  MONTHLY_REVENUE_TARGET_CODE,
  SETTING_DEFINITIONS,
  targetOf,
  AI_DESCRIPTION_WRITER_CODE,
  AI_DESCRIPTION_WRITER_TIER_CODE,
  OFFER_REVIEW_CODES,
  OFFER_REVIEW_EMERGENCY_STOP_CODE,
  type SettingDefinition,
} from '../domain/definitions';
import type { RecordedRequest } from '../../system-requests';
import type { SettingsDependencies } from './settings-dependencies';

/** The subject kind of a Market setting in the System requests queue (area marketplace). */
export const SETTING_SUBJECT_KIND = 'settings.market-setting';
/** The review area every Market setting belongs to. */
export const SETTINGS_REVIEW_AREA = 'marketplace';
/**
 * The AI settings are reviewed at high risk (one at a time, with the reviewer's step-up), and a
 * revert never switches the AI writer back on: an operator's "off" stands until someone with the
 * AI setting's own key switches it on (ADR-0019 R8; Hassan, PR #912).
 */
const AI_CODES: ReadonlySet<string> = new Set([
  AI_DESCRIPTION_WRITER_CODE,
  AI_DESCRIPTION_WRITER_TIER_CODE,
]);
/**
 * Reviewed at high risk too: one change can take every Offer past the admin, badges included
 * (Hassan, PR #1329).
 */
const HIGH_RISK_CODES: ReadonlySet<string> = new Set([
  ...AI_CODES,
  ...OFFER_REVIEW_CODES,
  OFFER_REVIEW_EMERGENCY_STOP_CODE,
]);

// Admin-editable Market settings (ADR-0026). A change is refused in an acting-as session, checks
// the version the admin saw (a stale edit is refused), writes the value and a history row in one
// unit, and is audited. Asking for the value already in force changes nothing.

const logger = new Logger('SettingsFlow');

type ChoiceValue = Parameters<typeof MarketSettingChanged.entry>[1]['before']['value'];

/**
 * The audit row of one change: a choice's values, a whole number setting's numbers, or the
 * monthly revenue target's amounts.
 */
function changeEntry(
  definition: SettingDefinition,
  was: string,
  next: string,
  version: number,
): AuditEntry {
  if (definition.code === MONTHLY_REVENUE_TARGET_CODE) {
    return MonthlyRevenueTargetChanged.entry('monthly-revenue-target', {
      before: { target: targetOf(was) },
      after: { target: targetOf(next), version },
    });
  }
  if (definition.integer !== undefined) {
    // A stored value outside the definition (a row changed by hand) is audited as the default it
    // stands for, and logged, so the page can still be saved over it.
    const before = acceptedValue(definition, was);
    if (before === null) {
      logger.error({ msg: 'settings.stored-value-invalid', code: definition.code });
    }
    return MarketNumberSettingChanged.entry(
      definition.code as (typeof NUMBER_SETTING_TARGET_IDS)[number],
      {
        before: { value: Number(before ?? definition.defaultValue) },
        after: { value: Number(next), version },
      },
    );
  }
  return MarketSettingChanged.entry(definition.code as (typeof SETTING_TARGET_IDS)[number], {
    before: { value: was as ChoiceValue },
    after: { value: next as ChoiceValue, version },
  });
}

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
  /**
   * Whether a change is reviewed in the Market (Admin Inbox › System requests) and at which
   * risk: the page asks for a note on save only when it is.
   */
  readonly review: SettingsReview;
}

/** Whether a change of these settings is reviewed in the Market (the page then asks for a note). */
export interface SettingsReview {
  readonly reviewed: boolean;
  readonly risk: 'low' | 'medium' | 'high';
}

/** A change's answer: the value in force and the review request it opened, if any. */
export interface SettingChangeView extends SettingView {
  readonly request: Pick<RecordedRequest, 'id' | 'number'> | null;
}

/** The review policy of the settings area, for the page (the area's default on a failure). */
export async function settingsReview(
  deps: SettingsDependencies,
  context: CallContext,
): Promise<SettingsReview> {
  const policy = await deps.review.areaPolicy(context, SETTINGS_REVIEW_AREA);
  return { reviewed: policy.enabled, risk: policy.risk };
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

/** The named settings of the Market with the value in force (the caller holds their view key). */
export async function viewSettings(
  deps: SettingsDependencies,
  context: CallContext,
  codes: readonly string[],
): Promise<Result<readonly SettingView[], SettingsFailure>> {
  // Its own read-only unit, before this one (units do not nest).
  const review = await settingsReview(deps, context);
  return deps.unitOfWork.run<readonly SettingView[], SettingsFailure>(
    context.market,
    async () => {
      const rows = await deps.settings.list(context.market);
      return ok(
        SETTING_DEFINITIONS.filter((definition) => codes.includes(definition.code)).map(
          (definition) => {
            const row = rows.find((candidate) => candidate.code === definition.code);
            return {
              code: definition.code,
              value: row?.value ?? definition.defaultValue,
              version: row?.version ?? 0,
              updatedAt: row?.updatedAt ?? null,
              review,
            };
          },
        ),
      );
    },
    { readOnly: true },
  );
}

/**
 * A read that fell back to the safe value is logged with the setting and the reason, never the
 * error text (it can carry connection details). Operators alert on this message: a store that
 * keeps failing silently turns every list in both panels to Previous and next.
 */
function logReadFailure(context: CallContext, code: string, reason: string): void {
  logger.warn({
    msg: 'settings.read-fell-back-to-safe-value',
    code,
    reason,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
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
    if (!read.ok) {
      logReadFailure(context, definition.code, 'unit-failed');
      return definition.safeValue;
    }
    const stored = read.value?.value;
    if (stored === undefined) return definition.defaultValue;
    // A stored value the definition no longer allows (bounds narrowed, a row changed by hand) is
    // never passed on: the safe value instead (Hassan, PR #1329).
    if (acceptedValue(definition, stored) === null) {
      logReadFailure(context, definition.code, 'stored-value-invalid');
      return definition.safeValue;
    }
    return stored;
  } catch {
    // An unreadable store is not the Market's choice: answer the safe value (ADR-0026 decision 5).
    logReadFailure(context, definition.code, 'store-unreadable');
    return definition.safeValue;
  }
}

/** One requested change, before it is checked against its definition. */
export interface SettingChangeInput {
  readonly code?: unknown;
  readonly value?: unknown;
  readonly expectedVersion?: unknown;
}

type Checked = {
  readonly definition: SettingDefinition;
  readonly next: string;
  readonly seen: number;
};

/** One change checked against its definition and the codes the caller's key covers. */
function checkChange(
  allowedCodes: readonly string[],
  input: SettingChangeInput,
  prefix: string,
): Checked | FieldIssue[] {
  const definition =
    typeof input?.code === 'string' && allowedCodes.includes(input.code)
      ? findDefinition(input.code)
      : null;
  if (definition === null) return [{ path: `${prefix}code`, code: 'value' }];
  const fields: FieldIssue[] = [];
  const next = acceptedValue(definition, input.value);
  if (next === null) fields.push({ path: `${prefix}value`, code: 'value' });
  const { expectedVersion } = input;
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) {
    fields.push({ path: `${prefix}expectedVersion`, code: 'type' });
  }
  if (fields.length > 0 || next === null) return fields;
  return { definition, next, seen: expectedVersion as number };
}

/**
 * One checked change inside the caller's open unit: the version check, the value and its history
 * row, the audit row and the review request. A conflict or a refused review is an error, which
 * rolls the whole unit back.
 */
async function applyChecked(
  deps: SettingsDependencies,
  context: CallContext,
  adminId: Id<'Account'>,
  { definition, next, seen }: Checked,
  now: Temporal.Instant,
  reviewPolicy: SettingsReview,
  note: unknown,
): Promise<Result<SettingChangeView, SettingsFailure>> {
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
      review: reviewPolicy,
      request: null,
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
  await deps.audit.record(context, changeEntry(definition, was, next, version));
  // The change is live; its review opens in the same unit (a refusal rolls the change back).
  const review = await deps.review.openReview(context, {
    area: SETTINGS_REVIEW_AREA,
    subjectKind: SETTING_SUBJECT_KIND,
    subjectRef: definition.code,
    before: { value: was },
    after: { value: next },
    note,
    ...(HIGH_RISK_CODES.has(definition.code) ? { risk: 'high' as const } : {}),
  });
  if (!review.ok) return err(review.error);
  return ok({
    code: definition.code,
    value: next,
    version,
    updatedAt: now,
    review: reviewPolicy,
    request: review.value === null ? null : { id: review.value.id, number: review.value.number },
  });
}

export async function changeSetting(
  deps: SettingsDependencies,
  context: CallContext,
  /** The one setting the caller's manage key covers; any other code is a validation failure. */
  allowedCode: string,
  input: SettingChangeInput & {
    /** The admin's note for the reviewer; needed only where the area is reviewed. */
    readonly note?: unknown;
  },
): Promise<Result<SettingChangeView, SettingsFailure>> {
  const adminId = adminAccountId(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const checked = checkChange([allowedCode], input, '');
  if (Array.isArray(checked)) return err({ code: 'validation.failed', fields: checked });
  const now = deps.clock.now();
  const reviewPolicy = await settingsReview(deps, context);
  return deps.unitOfWork.run<SettingChangeView, SettingsFailure>(context.market, () =>
    applyChecked(deps, context, adminId, checked, now, reviewPolicy, input.note),
  );
}

/**
 * Several settings of one page changed together, all or nothing: each with the version the admin
 * saw, in one unit. A stale version of any of them is a conflict and nothing is saved. Each change
 * keeps its own history row, audit row and review request (so a reviewer can reject one of them).
 */
export async function changeSettings(
  deps: SettingsDependencies,
  context: CallContext,
  /** The settings the caller's manage key covers; any other code is a validation failure. */
  allowedCodes: readonly string[],
  input: { readonly changes?: unknown; readonly note?: unknown },
): Promise<Result<readonly SettingChangeView[], SettingsFailure>> {
  const adminId = adminAccountId(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const changes = input?.changes;
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > allowedCodes.length) {
    return err({ code: 'validation.failed', fields: [{ path: 'changes', code: 'value' }] });
  }
  const fields: FieldIssue[] = [];
  const checkedChanges: Checked[] = [];
  const codes = new Set<string>();
  changes.forEach((change: unknown, index) => {
    const checked = checkChange(allowedCodes, change as SettingChangeInput, `changes.${index}.`);
    if (Array.isArray(checked)) {
      fields.push(...checked);
    } else if (codes.has(checked.definition.code)) {
      fields.push({ path: `changes.${index}.code`, code: 'duplicate' });
    } else {
      codes.add(checked.definition.code);
      checkedChanges.push(checked);
    }
  });
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  const now = deps.clock.now();
  const reviewPolicy = await settingsReview(deps, context);
  // Where changes are reviewed, a missing note refuses the page before anything is written (the
  // review recorder checks it again per change).
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (reviewPolicy.reviewed && (note.length === 0 || note.length > 500)) {
    return err({ code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] });
  }
  return deps.unitOfWork.run<readonly SettingChangeView[], SettingsFailure>(
    context.market,
    async () => {
      // Every version first, so a stale one saves nothing (the unit also rolls back on an error).
      for (const { definition, seen } of checkedChanges) {
        const row = await deps.settings.find(context.market, definition.code);
        if ((row?.version ?? 0) !== seen) return err({ code: 'settings.conflict' as const });
      }
      const views: SettingChangeView[] = [];
      for (const checked of checkedChanges) {
        const result = await applyChecked(
          deps,
          context,
          adminId,
          checked,
          now,
          reviewPolicy,
          input.note,
        );
        if (!result.ok) return result;
        views.push(result.value);
      }
      return ok(views);
    },
  );
}

/**
 * Restores a Market setting's value before a change that a reviewer rejected or its author
 * withdrew, in the open unit of that decision (System requests). Only while the setting still
 * holds the value after the change; a code no longer defined is gone. The decision's admin stamps
 * the change; it is a new version with its history and audit row, and opens no new review.
 */
export async function revertSetting(
  deps: SettingsDependencies,
  context: CallContext,
  request: {
    readonly subjectRef: string;
    readonly before: Readonly<Record<string, unknown>>;
    readonly after: Readonly<Record<string, unknown>>;
  },
): Promise<'reverted' | 'changed-since' | 'gone' | 'not-permitted'> {
  const adminId = adminAccountId(context);
  if (adminId === null) throw new Error('settings: a revert needs a signed-in admin');
  const definition = findDefinition(request.subjectRef);
  const restore = definition === null ? null : acceptedValue(definition, request.before.value);
  if (definition === null || restore === null) return 'gone';
  const row = await deps.settings.find(context.market, definition.code);
  const current = row?.value ?? definition.defaultValue;
  if (current !== request.after.value) return 'changed-since';
  if (definition.code === AI_DESCRIPTION_WRITER_CODE && restore === 'on') return 'not-permitted';
  const version = (row?.version ?? 0) + 1;
  const now = deps.clock.now();
  const applied = await deps.settings.apply(context.market, {
    code: definition.code,
    value: restore,
    previousValue: row?.value ?? null,
    version,
    changedAt: now,
    changedBy: adminId,
  });
  if (!applied) return 'changed-since';
  await deps.audit.record(context, changeEntry(definition, current, restore, version));
  return 'reverted';
}
