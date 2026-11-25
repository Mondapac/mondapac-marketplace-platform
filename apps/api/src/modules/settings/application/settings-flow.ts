import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import {
  MarketSettingChanged,
  MonthlyRevenueTargetChanged,
  type SETTING_TARGET_IDS,
} from '../domain/audit';
import {
  findDefinition,
  isAllowedValue,
  MONTHLY_REVENUE_TARGET_CODE,
  SETTING_DEFINITIONS,
  targetOf,
  type CartMode,
  type ListPaging,
  AI_DESCRIPTION_WRITER_CODE,
  AI_DESCRIPTION_WRITER_TIER_CODE,
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

// Admin-editable Market settings (ADR-0026). A change is refused in an acting-as session, checks
// the version the admin saw (a stale edit is refused), writes the value and a history row in one
// unit, and is audited. Asking for the value already in force changes nothing.

const logger = new Logger('SettingsFlow');

type SettingValue = ListPaging | CartMode;

/** The audit row of a change: the amount action for the target, the enum action otherwise. */
function changedEntry(code: string, was: string, next: string, version: number): AuditEntry {
  if (code === MONTHLY_REVENUE_TARGET_CODE) {
    return MonthlyRevenueTargetChanged.entry('monthly-revenue-target', {
      before: { target: targetOf(was) },
      after: { target: targetOf(next), version },
    });
  }
  return MarketSettingChanged.entry(code as (typeof SETTING_TARGET_IDS)[number], {
    before: { value: was as SettingValue },
    after: { value: next as SettingValue, version },
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
    return read.value?.value ?? definition.defaultValue;
  } catch {
    // An unreadable store is not the Market's choice: answer the safe value (ADR-0026 decision 5).
    logReadFailure(context, definition.code, 'store-unreadable');
    return definition.safeValue;
  }
}

export async function changeSetting(
  deps: SettingsDependencies,
  context: CallContext,
  /** The one setting the caller's manage key covers; any other code is a validation failure. */
  allowedCode: string,
  input: {
    readonly code?: unknown;
    readonly value?: unknown;
    readonly expectedVersion?: unknown;
    /** The admin's note for the reviewer; needed only where the area is reviewed. */
    readonly note?: unknown;
  },
): Promise<Result<SettingChangeView, SettingsFailure>> {
  const adminId = adminAccountId(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const definition = input?.code === allowedCode ? findDefinition(allowedCode) : null;
  if (definition === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'code', code: 'value' }] });
  }
  const { value, expectedVersion } = input;
  const fields: FieldIssue[] = [];
  if (!isAllowedValue(definition, value)) {
    fields.push({ path: 'value', code: 'value' });
  }
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) {
    fields.push({ path: 'expectedVersion', code: 'type' });
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  const next = value as string;
  const seen = expectedVersion as number;
  const now = deps.clock.now();
  const reviewPolicy = await settingsReview(deps, context);
  return deps.unitOfWork.run<SettingChangeView, SettingsFailure>(context.market, async () => {
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
    await deps.audit.record(context, changedEntry(definition.code, was, next, version));
    // The change is live; its review opens in the same unit (a refusal rolls the change back).
    const review = await deps.review.openReview(context, {
      area: SETTINGS_REVIEW_AREA,
      subjectKind: SETTING_SUBJECT_KIND,
      subjectRef: definition.code,
      before: { value: was },
      after: { value: next },
      note: input.note,
      ...(AI_CODES.has(definition.code) ? { risk: 'high' as const } : {}),
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
  });
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
  const restore = request.before.value;
  if (definition === null || !isAllowedValue(definition, restore)) {
    return 'gone';
  }
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
  await deps.audit.record(context, changedEntry(definition.code, current, restore, version));
  return 'reverted';
}
