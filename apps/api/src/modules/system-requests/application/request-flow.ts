import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { ConsumedStepUp, PermissionKey, StepUpRefusal } from '../../../platform/authz';
import type {
  AppliedChange,
  ProposedChange,
  ProposeFailure,
  RecordedRequest,
  RecordFailure,
} from '../contracts/recorder';
import {
  CHANGE_IMPACT_LABELS,
  IMPACT_TIMEOUT_MS,
  impactItem,
  MAX_DESCRIBE_REFS,
  MAX_IMPACT_ITEMS,
  type ChangeImpact,
  type ChangeImpactItem,
  type ChangeImpactLabel,
  type RevertRequest,
} from '../../../platform/change-review/change-review';
import { SYSTEM_REQUESTS_DECIDE_HIGH_STEP_UP } from '../contracts/step-up';
import {
  AREA_DEFAULTS,
  DEFAULT_REVIEW_DUE_DAYS,
  higherRisk,
  isPolicyArea,
  isRisk,
  REVIEW_AREAS,
  REVIEW_POLICY_POLICY,
  type AreaPolicy,
  type PolicyArea,
  type ReviewArea,
  type Risk,
} from '../domain/areas';
import { RequestApproved, RequestCommented, RequestOpened, RequestReverted } from '../domain/audit';
import {
  actionsFor,
  checkText,
  isChangeValues,
  isOverdue,
  isSubjectRef,
  isSubjectKind,
  MAX_COMMENT,
  MAX_NOTE,
  MAX_REASON,
  sameValues,
  type ChangeValues,
  type RequestAction,
  type SystemRequest,
  type Viewer,
} from '../domain/request';
import type { ActivityRecord } from './ports/request.repository';
import type { ImpactCacheKey } from './impact-cache';
import { REVIEW_KEYS } from './review-keys';
import type { SystemRequestsDependencies } from './system-requests-dependencies';

// System requests (Admin Inbox › System requests; owner decisions of 15 Nov 2026). A change in a
// reviewed area goes live at once and opens a request that keeps the values before and after.
// Another admin who holds the area's review key approves it (it stays live) or rejects it (the
// owning module restores the value before, in the same unit, only if nobody changed it since).
// The author never approves or rejects their own change, and may withdraw it (the same revert).
// High-risk decisions spend a fresh admin step-up proof. There is no expiry: an open request past
// its review date is overdue. Every write is refused in an acting-as session and audited.
// A delete, a merge or an import (owner decision of 18 Nov 2026) is a proposal instead (mode
// `approval`): nothing is applied when it is asked for; an approval runs the owning module's
// applier in the decision's unit, and a reject or withdraw changes nothing.

const logger = new Logger('SystemRequestsFlow');

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
}

export type SystemRequestsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string }
  | { readonly code: 'system-requests.not-found' }
  /** The request was already approved or reverted. */
  | { readonly code: 'system-requests.decided' }
  /** Maker-checker: the author cannot approve or reject their own change. */
  | { readonly code: 'system-requests.own-request' }
  /**
   * Separation of duties: the change is about the decider (their own account, or a role they
   * hold), as the owning module's reverter says; they may neither approve nor reject it.
   */
  | { readonly code: 'system-requests.own-subject' }
  /** Only the author withdraws a change. */
  | { readonly code: 'system-requests.not-author' }
  /** The caller does not hold the area's review key. */
  | { readonly code: 'system-requests.not-reviewer' }
  /**
   * The subject changed again after this request: reverting would undo the later change too.
   * `newerRequestId` names the later request when one was opened.
   */
  | {
      readonly code: 'system-requests.changed-since';
      readonly newerRequestId: Id<'SystemRequest'> | null;
    }
  /** The subject no longer exists; there is nothing to restore. */
  | { readonly code: 'system-requests.subject-gone' }
  /** No module restores this kind of change in this build. */
  | { readonly code: 'system-requests.revert-unavailable' }
  /** The owning module refuses this admin the change the revert would make. */
  | { readonly code: 'system-requests.revert-not-permitted' }
  /** Bulk approve takes low-risk requests only. */
  | { readonly code: 'system-requests.not-low-risk' }
  /** Bulk approve takes no proposal: a proposal is applied when approved, one by one. */
  | { readonly code: 'system-requests.one-by-one' }
  /** Another admin changed the policy first; the page reloads. */
  | { readonly code: 'system-requests.policy-conflict' };

const invalid = (fields: readonly FieldIssue[]): SystemRequestsFailure => ({
  code: 'validation.failed',
  fields,
});

export function isActingAs(context: CallContext): boolean {
  const actor = context.actor;
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}

/** The signed-in admin acting as themselves, or null (reads and writes alike). */
export function signedInAdmin(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAs(context)) {
    return null;
  }
  return actor.accountId;
}

export const requestIdOf = (value: unknown): Id<'SystemRequest'> | null => {
  if (typeof value !== 'string') return null;
  const parsed = parseId(value);
  return parsed.ok ? (parsed.value as Id<'SystemRequest'>) : null;
};

/** identity's refusal of the step-up, as these use cases answer it; anything else stays closed. */
export function stepUpFailure(refusal: StepUpRefusal): SystemRequestsFailure {
  if (
    refusal.code === 'second-factor.required' ||
    refusal.code === 'second-factor.enrolment-required'
  ) {
    return { code: refusal.code, actionKey: refusal.actionKey };
  }
  return { code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied' };
}

/**
 * The areas whose review key the caller holds, asked of the authorisation check (one call per
 * distinct key, outside any unit). A failed check fails closed: the area is not reviewable.
 */
export async function reviewableAreas(
  deps: SystemRequestsDependencies,
  context: CallContext,
): Promise<ReadonlySet<ReviewArea>> {
  const answers = new Map<string, boolean>();
  const areas = new Set<ReviewArea>();
  for (const area of REVIEW_AREAS) {
    const key = REVIEW_KEYS[area];
    let allowed = answers.get(key);
    if (allowed === undefined) {
      try {
        const decision = await deps.authorisation.check(context, {
          name: 'system-requests.review-area',
          rule: { kind: 'permissions', allOf: [key] },
        });
        allowed = decision.allowed;
      } catch (error) {
        logger.error({
          msg: 'system-requests.review-key-check-failed',
          error: error instanceof Error ? error.name : 'unknown',
          marketId: context.market.marketId,
          correlationId: context.correlationId,
        });
        allowed = false;
      }
      answers.set(key, allowed);
    }
    if (allowed) areas.add(area);
  }
  return areas;
}

/** Whether the caller holds the review key of one area (fails closed). */
async function reviews(
  deps: SystemRequestsDependencies,
  context: CallContext,
  area: ReviewArea,
): Promise<boolean> {
  return holds(deps, context, 'system-requests.review-area', [REVIEW_KEYS[area]]);
}

/** Whether the caller holds every key, asked of the authorisation check (fails closed). */
async function holds(
  deps: SystemRequestsDependencies,
  context: CallContext,
  name: string,
  keys: readonly [PermissionKey, ...PermissionKey[]],
): Promise<boolean> {
  try {
    const decision = await deps.authorisation.check(context, {
      name,
      rule: { kind: 'permissions', allOf: keys },
    });
    return decision.allowed;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Opening a request (in an open unit)

/** The policy of an area in the Market, in the open unit: the stored row or the default. */
export async function policyInUnit(
  deps: SystemRequestsDependencies,
  context: CallContext,
  area: ReviewArea,
): Promise<AreaPolicy> {
  if (area === 'review-policy') return REVIEW_POLICY_POLICY;
  const row = await deps.policy.area(context.market, area);
  return row === null ? AREA_DEFAULTS[area] : { enabled: row.enabled, risk: row.risk };
}

/** The Market's review period in days, in the open unit. */
async function dueDaysInUnit(
  deps: SystemRequestsDependencies,
  context: CallContext,
): Promise<number> {
  const row = await deps.policy.dueDays(context.market);
  return row?.reviewDueDays ?? DEFAULT_REVIEW_DUE_DAYS;
}

export const dueAfter = (appliedAt: Temporal.Instant, days: number): Temporal.Instant =>
  appliedAt.add({ hours: days * 24 });

export interface ChangeToOpen {
  readonly area: ReviewArea;
  readonly subjectKind: string;
  readonly subjectRef: string;
  readonly before: ChangeValues;
  readonly after: ChangeValues;
  /** Checked already. */
  readonly note: string;
  readonly risk?: Risk;
  /** `review` unless given. */
  readonly mode?: SystemRequest['mode'];
}

/**
 * Opens the review of a change already written in the open unit; nothing when the area is not
 * reviewed in the Market (the review policy itself always is). The caller is a signed-in admin.
 */
export async function openInUnit(
  deps: SystemRequestsDependencies,
  context: CallContext,
  admin: Id<'Account'>,
  change: ChangeToOpen,
): Promise<RecordedRequest | null> {
  const policy = await policyInUnit(deps, context, change.area);
  if (!policy.enabled) return null;
  const risk = change.risk === undefined ? policy.risk : higherRisk(policy.risk, change.risk);
  const now = deps.clock.now();
  const reviewDueAt = dueAfter(now, await dueDaysInUnit(deps, context));
  const id = deps.ids.next<'SystemRequest'>();
  const opened = await deps.requests.open(
    context.market,
    {
      id,
      area: change.area,
      subjectKind: change.subjectKind,
      subjectRef: change.subjectRef,
      mode: change.mode ?? 'review',
      risk,
      before: change.before,
      after: change.after,
      note: change.note,
      requestedBy: admin,
      appliedAt: now,
      reviewDueAt,
    },
    deps.ids.next<'SystemRequestActivity'>(),
  );
  await deps.audit.record(
    context,
    RequestOpened.entry(id, {
      after: {
        number: opened.number,
        area: change.area,
        risk,
        reviewDueAt,
        supersedes: opened.superseded.slice(0, 10),
      },
    }),
  );
  return { id, number: opened.number, risk, reviewDueAt };
}

/**
 * `SystemRequestRecorder.openReview`: checks what the owning module hands over and opens the review
 * in the caller's open unit. A malformed kind, key or value, an area outside the policy areas,
 * or a kind no module can revert is a programming error of the caller: it throws, and the
 * caller's unit rolls back. A missing note is the admin's: `validation.failed` on `note`, asked
 * only when the area is reviewed in the Market (else nothing opens and no note is needed).
 */
export async function recordAppliedChange(
  deps: SystemRequestsDependencies,
  context: CallContext,
  change: AppliedChange,
): Promise<Result<RecordedRequest | null, RecordFailure>> {
  if (!isPolicyArea(change?.area)) throw new TypeError('system-requests: unknown area');
  if (!isSubjectKind(change.subjectKind)) throw new TypeError('system-requests: bad subject kind');
  if (change.subjectKind.startsWith('system-requests.')) {
    throw new TypeError('system-requests: the review policy records its own changes');
  }
  if (!isSubjectRef(change.subjectRef)) throw new TypeError('system-requests: bad subject key');
  if (!isChangeValues(change.before) || !isChangeValues(change.after)) {
    throw new TypeError('system-requests: values must be a plain JSON object (see isChangeValues)');
  }
  if (change.risk !== undefined && !isRisk(change.risk)) {
    throw new TypeError('system-requests: unknown risk');
  }
  const registered = deps.reverters.find(change.subjectKind);
  if (registered === null) {
    throw new TypeError(`system-requests: no reverter registered for ${change.subjectKind}`);
  }
  if (registered.area !== change.area) {
    throw new TypeError(
      `system-requests: ${change.subjectKind} is reviewed in ${registered.area}, not ${change.area}`,
    );
  }
  if (registered.mode !== 'review') {
    throw new TypeError(`system-requests: ${change.subjectKind} waits for approval: proposeChange`);
  }
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  if (sameValues(change.before, change.after)) return ok(null);
  // The note is asked for only where the change is reviewed: an area that is off opens nothing.
  if (!(await policyInUnit(deps, context, change.area)).enabled) return ok(null);
  const note = checkText(change.note, MAX_NOTE);
  if (!note.ok)
    return err({ code: 'validation.failed', fields: [{ path: 'note', code: note.code }] });
  return ok(
    await openInUnit(deps, context, admin, {
      area: change.area,
      subjectKind: change.subjectKind,
      subjectRef: change.subjectRef,
      before: change.before,
      after: change.after,
      note: note.text,
      ...(change.risk === undefined ? {} : { risk: change.risk }),
    }),
  );
}

/**
 * `SystemRequestRecorder.proposeChange`: checks what the owning module hands over and opens a
 * proposal (approval mode) in the caller's open unit; the owning module writes nothing now. The
 * same programming errors throw as for a change; the kind must be registered with an applier.
 * `ok(null)` when the area is not reviewed in the Market: the caller applies the action at once.
 * One open proposal per subject: a second is `system-requests.already-pending` (a unique index
 * holds it too).
 */
export async function recordProposedChange(
  deps: SystemRequestsDependencies,
  context: CallContext,
  change: ProposedChange,
): Promise<Result<RecordedRequest | null, ProposeFailure>> {
  if (!isPolicyArea(change?.area)) throw new TypeError('system-requests: unknown area');
  if (!isSubjectKind(change.subjectKind)) throw new TypeError('system-requests: bad subject kind');
  if (!isSubjectRef(change.subjectRef)) throw new TypeError('system-requests: bad subject key');
  if (!isChangeValues(change.before) || !isChangeValues(change.after)) {
    throw new TypeError('system-requests: values must be a plain JSON object (see isChangeValues)');
  }
  if (change.risk !== undefined && !isRisk(change.risk)) {
    throw new TypeError('system-requests: unknown risk');
  }
  const registered = deps.reverters.find(change.subjectKind);
  if (registered === null || registered.mode !== 'approval') {
    throw new TypeError(`system-requests: no applier registered for ${change.subjectKind}`);
  }
  if (registered.area !== change.area) {
    throw new TypeError(
      `system-requests: ${change.subjectKind} is reviewed in ${registered.area}, not ${change.area}`,
    );
  }
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  if (!(await policyInUnit(deps, context, change.area)).enabled) return ok(null);
  const note = checkText(change.note, MAX_NOTE);
  if (!note.ok)
    return err({ code: 'validation.failed', fields: [{ path: 'note', code: note.code }] });
  const pending = await deps.requests.findPendingProposal(
    context.market,
    change.subjectKind,
    change.subjectRef,
  );
  if (pending !== null) {
    return err({ code: 'system-requests.already-pending', pendingNumber: pending.number });
  }
  return ok(
    await openInUnit(deps, context, admin, {
      area: change.area,
      subjectKind: change.subjectKind,
      subjectRef: change.subjectRef,
      before: change.before,
      after: change.after,
      note: note.text,
      mode: 'approval',
      ...(change.risk === undefined ? {} : { risk: change.risk }),
    }),
  );
}

/** `SystemRequestRecorder.areaPolicy`: a read-only unit of its own; the default on a failure. */
export async function areaPolicyOf(
  deps: SystemRequestsDependencies,
  context: CallContext,
  area: PolicyArea,
): Promise<AreaPolicy> {
  try {
    const read = await deps.unitOfWork.run(
      context.market,
      async () => ok(await policyInUnit(deps, context, area)),
      { readOnly: true },
    );
    return read.ok ? read.value : AREA_DEFAULTS[area];
  } catch {
    logger.warn({
      msg: 'system-requests.policy-read-fell-back-to-default',
      area,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return AREA_DEFAULTS[area];
  }
}

// ---------------------------------------------------------------------------------------------
// Views

export interface ActivityView {
  readonly id: Id<'SystemRequestActivity'>;
  readonly kind: ActivityRecord['kind'];
  readonly actor: Id<'Account'>;
  /** The actor's display name (identity), or null when it cannot be read. */
  readonly actorName: string | null;
  readonly at: Temporal.Instant;
  readonly body: string | null;
}

export interface RequestView extends Omit<SystemRequest, 'before' | 'after'> {
  /**
   * The values before and after, for the author and the area's reviewers only; null for any
   * other admin who sees the queue (Hassan L2: a module's values stay with its reviewers).
   */
  readonly before: ChangeValues | null;
  readonly after: ChangeValues | null;
  readonly overdue: boolean;
  /** The key a reviewer of this request holds. */
  readonly reviewPermission: string;
  readonly actions: readonly RequestAction[];
  /** The author's and the decider's display names (identity's facade); null when unknown. */
  readonly requestedByName: string | null;
  readonly decidedByName: string | null;
  /** The owning module's label of the subject (its reverter's `describe`); null when none. */
  readonly subjectLabel: string | null;
  /** The SR number of `supersededBy`; null when not superseded. */
  readonly supersededByNumber: number | null;
}

export interface RequestDetailView extends RequestView {
  readonly activity: readonly ActivityView[];
  /**
   * How many records the change touches, from the owning module's `impact` (detail only): null
   * when the kind has none, the request is decided, the viewer may not see its values, or the
   * count failed or timed out.
   */
  readonly impact: ChangeImpact | null;
}

/**
 * A request as `viewer` sees it, without the labels read outside the unit ({@link withLabels}
 * adds them). `numbers` holds the SR numbers of the requests that superseded others, read in the
 * same unit ({@link supersedingNumbers}).
 */
export const requestView = (
  request: SystemRequest,
  viewer: Viewer,
  now: Temporal.Instant,
  numbers: ReadonlyMap<string, number> = new Map(),
): RequestView => {
  const shown = request.requestedBy === viewer.accountId || viewer.reviews.has(request.area);
  return {
    ...request,
    before: shown ? request.before : null,
    after: shown ? request.after : null,
    overdue: isOverdue(request, now),
    reviewPermission: REVIEW_KEYS[request.area],
    actions: actionsFor(request, viewer),
    requestedByName: null,
    decidedByName: null,
    subjectLabel: null,
    supersededByNumber:
      request.supersededBy === null ? null : (numbers.get(request.supersededBy) ?? null),
  };
};

/** The SR numbers of the requests that superseded any of `requests`, in the open unit. */
export async function supersedingNumbers(
  deps: SystemRequestsDependencies,
  context: CallContext,
  requests: readonly Pick<SystemRequest, 'supersededBy'>[],
): Promise<ReadonlyMap<string, number>> {
  const ids = [
    ...new Set(requests.flatMap((row) => (row.supersededBy === null ? [] : [row.supersededBy]))),
  ];
  if (ids.length === 0) return new Map();
  const found = await deps.requests.findMany(context.market, ids);
  return new Map(found.map((row) => [row.id, row.number]));
}

/** A label longer than this, empty, or with a control character is not shown. */
export const MAX_SUBJECT_LABEL = 200;

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || Array.from(text).length > MAX_SUBJECT_LABEL) return null;
  // Any "other" character, as closedBody refuses: controls (C0 and C1), format characters (bidi
  // overrides and isolates, zero-width ones), private use and unassigned code points; and the
  // line and paragraph separators U+2028 and U+2029, which are not in \p{C}.
  if (/[\p{C}\u2028\u2029]/u.test(text)) return null;
  return text;
}

const subjectKey = (kind: string, ref: string): string => `${kind} ${ref}`;

/**
 * The owning modules' labels of the subjects, one `describe` per kind (at most 100 refs a call),
 * outside any unit. A kind without `describe`, a throw and a malformed label give no label.
 */
async function subjectLabels(
  deps: SystemRequestsDependencies,
  context: CallContext,
  requests: readonly Pick<SystemRequest, 'subjectKind' | 'subjectRef'>[],
): Promise<ReadonlyMap<string, string>> {
  const byKind = new Map<string, string[]>();
  for (const request of requests) {
    const refs = byKind.get(request.subjectKind) ?? [];
    if (!refs.includes(request.subjectRef)) refs.push(request.subjectRef);
    byKind.set(request.subjectKind, refs);
  }
  const labels = new Map<string, string>();
  for (const [kind, refs] of byKind) {
    const reverter = deps.reverters.find(kind)?.hooks;
    if (reverter?.describe === undefined) continue;
    for (let start = 0; start < refs.length; start += MAX_DESCRIBE_REFS) {
      const chunk = refs.slice(start, start + MAX_DESCRIBE_REFS);
      try {
        const answer = await reverter.describe(context, chunk);
        for (const ref of chunk) {
          const label = cleanLabel(typeof answer?.get === 'function' ? answer.get(ref) : null);
          if (label !== null) labels.set(subjectKey(kind, ref), label);
        }
      } catch (error) {
        // The kind and the kind of failure only: never a ref or a label.
        logger.warn({
          msg: 'system-requests.subject-labels-unavailable',
          subjectKind: kind,
          error: error instanceof Error ? error.name : 'unknown',
          marketId: context.market.marketId,
          correlationId: context.correlationId,
        });
      }
    }
  }
  return labels;
}

/** The admin names of `accountIds`, outside any unit; none on a failure. */
export async function adminNamesOf(
  deps: SystemRequestsDependencies,
  context: CallContext,
  accountIds: readonly (string | null)[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(accountIds.filter((value): value is string => value !== null))];
  if (ids.length === 0) return new Map();
  try {
    return await deps.adminNames.namesOf(context, ids);
  } catch {
    return new Map();
  }
}

/**
 * Adds the human labels to views built in a unit, after it: the author's, the decider's and each
 * history line's admin name (one read for the page) and the subject's label (one `describe` per
 * kind). Never fails: what cannot be read stays null.
 */
export async function withLabels<V extends RequestView>(
  deps: SystemRequestsDependencies,
  context: CallContext,
  views: readonly V[],
  activity: readonly ActivityRecord[] = [],
): Promise<{
  readonly views: readonly V[];
  readonly activity: readonly ActivityView[];
}> {
  const names = await adminNamesOf(deps, context, [
    ...views.flatMap((view) => [view.requestedBy, view.decidedBy]),
    ...activity.map((line) => line.actor),
  ]);
  const labels = await subjectLabels(deps, context, views);
  const nameOf = (accountId: string | null) =>
    accountId === null ? null : (names.get(accountId) ?? null);
  return {
    views: views.map((view) => ({
      ...view,
      requestedByName: nameOf(view.requestedBy),
      decidedByName: nameOf(view.decidedBy),
      subjectLabel: labels.get(subjectKey(view.subjectKind, view.subjectRef)) ?? null,
    })),
    activity: activity.map((line) => ({ ...line, actorName: nameOf(line.actor) })),
  };
}

/** One view with its labels (a decision's answer). */
async function labelled(
  deps: SystemRequestsDependencies,
  context: CallContext,
  result: Result<RequestView, SystemRequestsFailure>,
): Promise<Result<RequestView, SystemRequestsFailure>> {
  if (!result.ok) return result;
  const { views } = await withLabels(deps, context, [result.value]);
  return ok(views[0]!);
}

/** `ViewSystemRequest`: one request with its history and the caller's actions. */
export async function viewRequest(
  deps: SystemRequestsDependencies,
  context: CallContext,
  input: { readonly requestId: unknown },
): Promise<Result<RequestDetailView, SystemRequestsFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const id = requestIdOf(input?.requestId);
  if (id === null) return err(invalid([{ path: 'requestId', code: 'format' }]));
  const areas = await reviewableAreas(deps, context);
  const now = deps.clock.now();
  const read = await deps.unitOfWork.run<
    { readonly view: RequestView; readonly activity: readonly ActivityRecord[] },
    SystemRequestsFailure
  >(
    context.market,
    async () => {
      const request = await deps.requests.find(context.market, id);
      if (request === null) return err({ code: 'system-requests.not-found' });
      const activity = await deps.requests.activity(context.market, id);
      const numbers = await supersedingNumbers(deps, context, [request]);
      return ok({
        view: requestView(request, { accountId: admin, reviews: areas }, now, numbers),
        activity,
      });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const named = await withLabels(deps, context, [read.value.view], read.value.activity);
  const impact = await impactOf(deps, context, read.value.view);
  return ok({ ...named.views[0]!, activity: named.activity, impact });
}

const isImpactLabel = (value: unknown): value is ChangeImpactLabel =>
  typeof value === 'string' && (CHANGE_IMPACT_LABELS as readonly string[]).includes(value);

/** The owning module's answer as shown: known labels, whole counts, capped; null when none. */
function cleanImpact(answer: unknown): ChangeImpact | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const items: unknown = (answer as { readonly items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const shown: ChangeImpactItem[] = [];
  for (const item of items as readonly unknown[]) {
    if (shown.length === MAX_IMPACT_ITEMS) break;
    if (typeof item !== 'object' || item === null) continue;
    const { label, count, atLeast } = item as Record<string, unknown>;
    if (!isImpactLabel(label) || shown.some((entry) => entry.label === label)) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) continue;
    if (typeof atLeast !== 'boolean') continue;
    shown.push(impactItem(label, count, atLeast));
  }
  return shown.length === 0 ? null : { items: shown };
}

/**
 * Settles with `fallback` once `ms` have passed, unless `work` settles first; `onTimeout` runs
 * then (it aborts the hook's signal).
 */
async function within<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(fallback);
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const TIMED_OUT = Symbol('timed-out');

/**
 * The impact of an open request whose values the viewer sees (the author or a reviewer of its
 * area: counts never go further than the values do), from the owning module's optional `impact`,
 * outside any unit, with the viewer's context (the request was found in its Market). A kind
 * without the hook, a throw, a timeout ({@link IMPACT_TIMEOUT_MS}) or a malformed answer is null:
 * it never fails the page.
 */
export async function impactOf(
  deps: SystemRequestsDependencies,
  context: CallContext,
  view: RequestView,
  timeoutMs: number = IMPACT_TIMEOUT_MS,
): Promise<ChangeImpact | null> {
  if (view.status !== 'open' || view.before === null || view.after === null) return null;
  const hooks = deps.reverters.find(view.subjectKind)?.hooks;
  if (typeof hooks?.impact !== 'function') return null;
  const viewerId = signedInAdmin(context);
  if (viewerId === null) return null;
  const key: ImpactCacheKey = {
    marketId: context.market.marketId,
    requestId: view.id,
    status: view.status,
    supersededBy: view.supersededBy,
    viewerId,
  };
  const kept = deps.impactCache.get(key, deps.clock.now());
  if (kept !== undefined) return kept;
  const request: RevertRequest = {
    requestId: view.id,
    subjectRef: view.subjectRef,
    before: view.before,
    after: view.after,
  };
  const abort = new AbortController();
  try {
    const answer = await within<unknown>(
      Promise.resolve().then(() => hooks.impact!(context, request, abort.signal)),
      timeoutMs,
      TIMED_OUT,
      () => abort.abort(),
    );
    if (answer === TIMED_OUT) {
      logger.warn({
        msg: 'system-requests.impact-unavailable',
        subjectKind: view.subjectKind,
        error: 'timeout',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return null;
    }
    const impact = cleanImpact(answer);
    // Only an answer given in time is kept: a timeout or a failure asks again next time.
    deps.impactCache.set(key, impact, deps.clock.now());
    return impact;
  } catch (error) {
    // The kind and the kind of failure only: never a ref or a value.
    logger.warn({
      msg: 'system-requests.impact-unavailable',
      subjectKind: view.subjectKind,
      error: error instanceof Error ? error.name : 'unknown',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Comments and decisions

/** `CommentOnSystemRequest`: anyone who sees the queue comments, whatever the request's status. */
export async function commentOnRequest(
  deps: SystemRequestsDependencies,
  context: CallContext,
  input: { readonly requestId: unknown; readonly body: unknown },
): Promise<Result<ActivityView, SystemRequestsFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const fields: FieldIssue[] = [];
  const id = requestIdOf(input?.requestId);
  if (id === null) fields.push({ path: 'requestId', code: 'format' });
  const body = checkText(input?.body, MAX_COMMENT);
  if (!body.ok) fields.push({ path: 'body', code: body.code });
  if (fields.length > 0 || id === null || !body.ok) return err(invalid(fields));
  const now = deps.clock.now();
  const added = await deps.unitOfWork.run<ActivityRecord, SystemRequestsFailure>(
    context.market,
    async () => {
      const request = await deps.requests.find(context.market, id);
      if (request === null) return err({ code: 'system-requests.not-found' });
      const line: ActivityRecord = {
        id: deps.ids.next<'SystemRequestActivity'>(),
        kind: 'commented',
        actor: admin,
        at: now,
        body: body.text,
      };
      const commentCount = await deps.requests.addComment(context.market, id, line);
      await deps.audit.record(context, RequestCommented.entry(id, { after: { commentCount } }));
      return ok(line);
    },
  );
  if (!added.ok) return added;
  const names = await adminNamesOf(deps, context, [admin]);
  return ok({ ...added.value, actorName: names.get(admin) ?? null });
}

type DecisionKind = 'approve' | 'reject' | 'withdraw';

interface DecisionInput {
  readonly requestId: unknown;
  readonly reason?: unknown;
}

/**
 * The checks every decision shares, before its unit: the caller, the id, the reason (reject and
 * withdraw), and the area's review key (approve and reject), read from a first look at the row.
 * The unit checks the row again once it is locked.
 */
async function prepareDecision(
  deps: SystemRequestsDependencies,
  context: CallContext,
  kind: DecisionKind,
  input: DecisionInput,
): Promise<
  Result<
    {
      readonly admin: Id<'Account'>;
      readonly id: Id<'SystemRequest'>;
      readonly reason: string | null;
    },
    SystemRequestsFailure
  >
> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const fields: FieldIssue[] = [];
  const id = requestIdOf(input?.requestId);
  if (id === null) fields.push({ path: 'requestId', code: 'format' });
  let reason: string | null = null;
  if (kind !== 'approve') {
    const checked = checkText(input?.reason, MAX_REASON);
    if (checked.ok) reason = checked.text;
    else fields.push({ path: 'reason', code: checked.code });
  }
  if (fields.length > 0 || id === null) return err(invalid(fields));
  if (kind === 'withdraw') return ok({ admin, id, reason });
  const seen = await deps.unitOfWork.run<SystemRequest | null, SystemRequestsFailure>(
    context.market,
    async () => ok(await deps.requests.find(context.market, id)),
    { readOnly: true },
  );
  if (!seen.ok) return seen;
  if (seen.value === null) return err({ code: 'system-requests.not-found' });
  // The area never changes (a column the application cannot update), so the first look is safe.
  if (!(await reviews(deps, context, seen.value.area))) {
    return err({ code: 'system-requests.not-reviewer' });
  }
  return ok({ admin, id, reason });
}

/**
 * The locked open request `admin` may decide this way, or the refusal. An approval or a reject
 * also asks the owning module whether the change is about the decider (`isInterested`, read in
 * this unit); a module without that check lets any reviewer but the author decide.
 */
export async function decidable(
  deps: SystemRequestsDependencies,
  context: CallContext,
  kind: DecisionKind,
  admin: Id<'Account'>,
  id: Id<'SystemRequest'>,
): Promise<Result<SystemRequest, SystemRequestsFailure>> {
  const request = await deps.requests.findForUpdate(context.market, id);
  if (request === null) return err({ code: 'system-requests.not-found' });
  if (request.status !== 'open') return err({ code: 'system-requests.decided' });
  const own = request.requestedBy === admin;
  if (kind === 'withdraw' && !own) return err({ code: 'system-requests.not-author' });
  if (kind !== 'withdraw' && own) return err({ code: 'system-requests.own-request' });
  if (kind !== 'withdraw') {
    const reverter = deps.reverters.find(request.subjectKind)?.hooks;
    if (
      reverter?.isInterested !== undefined &&
      (await reverter.isInterested(context, {
        requestId: request.id,
        subjectRef: request.subjectRef,
        before: request.before,
        after: request.after,
      }))
    ) {
      return err({ code: 'system-requests.own-subject' });
    }
  }
  return ok(request);
}

/** Spends the step-up proof of a high-risk decision; nothing to spend below high. */
async function spendIfHigh(
  deps: SystemRequestsDependencies,
  context: CallContext,
  request: SystemRequest,
): Promise<Result<ConsumedStepUp | null, SystemRequestsFailure>> {
  if (request.risk !== 'high') return ok(null);
  const spent = await deps.stepUp.consume(context, SYSTEM_REQUESTS_DECIDE_HIGH_STEP_UP);
  return spent.ok ? ok(spent.value) : err(stepUpFailure(spent.error));
}

const proofFields = (proof: ConsumedStepUp | null) => ({
  stepUpSessionId: proof?.sessionId ?? null,
  stepUpVerifiedAt: proof?.verifiedAt ?? null,
});

/** Approves a locked open request in the open unit (the change stays live). */
export async function approveInUnit(
  deps: SystemRequestsDependencies,
  context: CallContext,
  admin: Id<'Account'>,
  request: SystemRequest,
  proof: ConsumedStepUp | null,
): Promise<SystemRequest> {
  const now = deps.clock.now();
  const written = await deps.requests.decide(context.market, request.id, {
    status: 'approved',
    decision: 'approved',
    decidedBy: admin,
    decidedAt: now,
    reason: null,
  });
  if (!written) throw new Error('system-requests: a locked open request changed');
  await deps.requests.addActivity(context.market, request.id, {
    id: deps.ids.next<'SystemRequestActivity'>(),
    kind: 'approved',
    actor: admin,
    at: now,
    body: null,
  });
  await deps.audit.record(
    context,
    RequestApproved.entry(request.id, {
      before: { status: 'open' },
      after: {
        status: 'approved',
        requestedBy: request.requestedBy,
        risk: request.risk,
        ...proofFields(proof),
      },
    }),
  );
  return {
    ...request,
    status: 'approved',
    decision: 'approved',
    decidedBy: admin,
    decidedAt: now,
    decisionReason: null,
  };
}

/** `ApproveSystemRequest`: another admin who reviews the area approves; the change stays live. */
export async function approveRequest(
  deps: SystemRequestsDependencies,
  context: CallContext,
  input: DecisionInput,
): Promise<Result<RequestView, SystemRequestsFailure>> {
  const prepared = await prepareDecision(deps, context, 'approve', input);
  if (!prepared.ok) return prepared;
  const { admin, id } = prepared.value;
  const proposal = await seenProposal(deps, context, admin, id);
  if (!proposal.ok) return proposal;
  if (proposal.value !== null) return applyProposal(deps, context, admin, id, proposal.value);
  const areas = await reviewableAreas(deps, context);
  const decided = await deps.unitOfWork.run<RequestView, SystemRequestsFailure>(
    context.market,
    async () => {
      const found = await decidable(deps, context, 'approve', admin, id);
      if (!found.ok) return found;
      // The mode never changes (no column grant), so the first look's answer holds.
      if (found.value.mode !== 'review') throw new Error('system-requests: a request changed mode');
      const proof = await spendIfHigh(deps, context, found.value);
      if (!proof.ok) return proof;
      // Approving keeps the change: no reverter is asked, so a subject gone since is no refusal.
      const approved = await approveInUnit(deps, context, admin, found.value, proof.value);
      const numbers = await supersedingNumbers(deps, context, [approved]);
      return ok(
        requestView(approved, { accountId: admin, reviews: areas }, deps.clock.now(), numbers),
      );
    },
  );
  return labelled(deps, context, decided);
}

/**
 * Asks an owning module's pre-unit `check` (of a revert or of an applied proposal). Fails closed:
 * a check that throws or answers anything but `ok` is `revert-not-permitted`. Ids only in logs.
 */
async function askCheck(
  context: CallContext,
  request: SystemRequest,
  check: (context: CallContext, request: RevertRequest) => Promise<'ok' | 'not-permitted'>,
): Promise<Result<null, SystemRequestsFailure>> {
  let answer: 'ok' | 'not-permitted';
  try {
    answer = await check(context, revertRequestOf(request));
  } catch (error) {
    logger.error({
      msg: 'system-requests.revert-check-failed',
      error: error instanceof Error ? error.name : 'unknown',
      requestId: request.id,
      subjectKind: request.subjectKind,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    answer = 'not-permitted';
  }
  return answer === 'ok' ? ok(null) : err({ code: 'system-requests.revert-not-permitted' });
}

const revertRequestOf = (request: SystemRequest): RevertRequest => ({
  requestId: request.id,
  subjectRef: request.subjectRef,
  before: request.before,
  after: request.after,
});

/**
 * A first look at the request before an approval: the open proposal (approval mode) with its
 * registered applier, or null for anything else (a change to review, a decided or missing
 * request: the approval's own unit answers those). A proposal whose kind has no applier any more
 * cannot be applied.
 */
async function seenProposal(
  deps: SystemRequestsDependencies,
  context: CallContext,
  admin: Id<'Account'>,
  id: Id<'SystemRequest'>,
): Promise<Result<SystemRequest | null, SystemRequestsFailure>> {
  const seen = await deps.unitOfWork.run<SystemRequest | null, SystemRequestsFailure>(
    context.market,
    async () => ok(await deps.requests.find(context.market, id)),
    { readOnly: true },
  );
  if (!seen.ok) return seen;
  const request = seen.value;
  if (request === null || request.mode !== 'approval' || request.status !== 'open') return ok(null);
  // The author is refused by the unit (own-request) before any module is asked.
  if (request.requestedBy === admin) return ok(null);
  return ok(request);
}

/**
 * Approves a proposal. Before the unit: the action's permission, registered with the applier,
 * checked here (Hassan M1: an owning module's `check` that answers `ok` for anyone cannot let a
 * reviewer run an action they may not run), then the module's own `check`, then the area's review
 * key and the action's permission once more, last thing before the unit opens (Hassan L2: the
 * authorisation check reads committed state in a unit of its own and is never called inside the
 * caller's, so this is as close to the decision as it can run). Then, in one serializable unit
 * with the decision, the module's `apply`, which writes the action only if the subject still
 * holds `before`. Anything but `applied` writes nothing and leaves the request open.
 */
async function applyProposal(
  deps: SystemRequestsDependencies,
  context: CallContext,
  admin: Id<'Account'>,
  id: Id<'SystemRequest'>,
  seen: SystemRequest,
): Promise<Result<RequestView, SystemRequestsFailure>> {
  const registered = deps.reverters.find(seen.subjectKind);
  if (registered?.mode !== 'approval') return err({ code: 'system-requests.revert-unavailable' });
  const { applier, permissions } = registered;
  const permitted = () => holds(deps, context, 'system-requests.apply-proposal', permissions);
  if (!(await permitted())) return err({ code: 'system-requests.revert-not-permitted' });
  const checked = await askCheck(context, seen, (c, r) => applier.check(c, r));
  if (!checked.ok) return checked;
  const areas = await reviewableAreas(deps, context);
  if (!areas.has(seen.area)) return err({ code: 'system-requests.not-reviewer' });
  if (!(await permitted())) return err({ code: 'system-requests.revert-not-permitted' });
  const decided = await deps.unitOfWork.run<RequestView, SystemRequestsFailure>(
    context.market,
    async () => {
      const found = await decidable(deps, context, 'approve', admin, id);
      if (!found.ok) return found;
      const request = found.value;
      const proof = await spendIfHigh(deps, context, request);
      if (!proof.ok) return proof;
      const outcome = await applier.apply(context, revertRequestOf(request));
      if (outcome === 'changed-since') {
        return err({ code: 'system-requests.changed-since', newerRequestId: null });
      }
      if (outcome === 'gone') return err({ code: 'system-requests.subject-gone' });
      if (outcome === 'not-permitted') return err({ code: 'system-requests.revert-not-permitted' });
      if (outcome !== 'applied') throw new Error('system-requests: unknown apply outcome');
      const approved = await approveInUnit(deps, context, admin, request, proof.value);
      return ok(requestView(approved, { accountId: admin, reviews: areas }, deps.clock.now()));
    },
    { isolation: 'serializable' },
  );
  return labelled(deps, context, decided);
}

/**
 * Runs the owning module's optional pre-unit `check` of a revert (see `SystemChangeReverter`),
 * before the decision unit opens. The values before and after of a request never change, so the
 * look taken here is the one the unit decides on; a request that is gone or no longer open is left
 * to the unit, which answers it, and so is a withdraw by anyone but the author (`not-author`), for
 * whom the check is not run. A check that throws fails closed: `revert-not-permitted`, nothing
 * written, the request stays open.
 */
async function checkBeforeRevert(
  deps: SystemRequestsDependencies,
  context: CallContext,
  kind: 'reject' | 'withdraw',
  admin: Id<'Account'>,
  id: Id<'SystemRequest'>,
): Promise<Result<null, SystemRequestsFailure>> {
  const seen = await deps.unitOfWork.run<SystemRequest | null, SystemRequestsFailure>(
    context.market,
    async () => ok(await deps.requests.find(context.market, id)),
    { readOnly: true },
  );
  if (!seen.ok) return seen;
  const request = seen.value;
  if (request === null || request.status !== 'open') return ok(null);
  // Only the author may withdraw: for anyone else the unit answers not-author, so the check (which
  // reads other modules) is not run for them.
  if (kind === 'withdraw' && request.requestedBy !== admin) return ok(null);
  // A proposal's reject or withdraw undoes nothing, so there is nothing to check.
  if (request.mode !== 'review') return ok(null);
  const reverter = deps.reverters.find(request.subjectKind)?.reverter;
  if (reverter?.check === undefined || reverter === null) return ok(null);
  return askCheck(context, request, (c, r) => reverter.check!(c, r));
}

/**
 * Restores the value before the change (reject or withdraw), in one unit with the decision: the
 * subject must still hold the value after the change, and no later request may exist for it.
 *
 * The unit is serializable: a reverter may re-check a guard by counting rows (identity's last
 * Platform Administrator, HF8), and every writer of those rows runs serializable, so a revert and
 * a concurrent change cannot each keep the one holder. A conflict is retried by the unit of work.
 */
async function revertRequest(
  deps: SystemRequestsDependencies,
  context: CallContext,
  kind: 'reject' | 'withdraw',
  input: DecisionInput,
): Promise<Result<RequestView, SystemRequestsFailure>> {
  const prepared = await prepareDecision(deps, context, kind, input);
  if (!prepared.ok) return prepared;
  const { admin, id, reason } = prepared.value;
  const checked = await checkBeforeRevert(deps, context, kind, admin, id);
  if (!checked.ok) return checked;
  const areas = await reviewableAreas(deps, context);
  const reverted = await deps.unitOfWork.run<RequestView, SystemRequestsFailure>(
    context.market,
    async () => {
      const found = await decidable(deps, context, kind, admin, id);
      if (!found.ok) return found;
      const request = found.value;
      const proposal = request.mode === 'approval';
      if (request.supersededBy !== null) {
        return err({ code: 'system-requests.changed-since', newerRequestId: request.supersededBy });
      }
      // A proposal was never applied: declining it or taking it back changes nothing, so it
      // needs no registered kind (Hassan L3: else a kind no longer registered would leave its
      // proposal, and through the one-open-proposal index its subject, stuck).
      const registered = proposal ? null : deps.reverters.find(request.subjectKind);
      if (!proposal && registered === null) {
        return err({ code: 'system-requests.revert-unavailable' });
      }
      const proof = await spendIfHigh(deps, context, request);
      if (!proof.ok) return proof;
      if (!proposal) {
        if (registered?.mode !== 'review') throw new Error('system-requests: a kind changed mode');
        const outcome = await registered.reverter.revert(context, revertRequestOf(request));
        if (outcome === 'changed-since') {
          return err({ code: 'system-requests.changed-since', newerRequestId: null });
        }
        if (outcome === 'gone') return err({ code: 'system-requests.subject-gone' });
        if (outcome === 'not-permitted') {
          return err({ code: 'system-requests.revert-not-permitted' });
        }
        if (outcome !== 'reverted') throw new Error('system-requests: unknown revert outcome');
      }
      const decision = kind === 'reject' ? 'rejected' : 'withdrawn';
      const now = deps.clock.now();
      const written = await deps.requests.decide(context.market, request.id, {
        status: 'reverted',
        decision,
        decidedBy: admin,
        decidedAt: now,
        reason,
      });
      if (!written) throw new Error('system-requests: a locked open request changed');
      // The subject holds the value before this change again, which is the value after the
      // requests this one superseded: they are the latest again, and can be decided in full
      // (Hassan H1: else an author could bury a change by superseding and withdrawing it).
      // A proposal superseded nothing.
      if (!proposal) await deps.requests.release(context.market, request.id);
      await deps.requests.addActivity(context.market, request.id, {
        id: deps.ids.next<'SystemRequestActivity'>(),
        kind: decision,
        actor: admin,
        at: now,
        body: reason,
      });
      await deps.audit.record(
        context,
        RequestReverted.entry(request.id, {
          before: { status: 'open' },
          after: {
            status: 'reverted',
            decision,
            requestedBy: request.requestedBy,
            risk: request.risk,
            ...proofFields(proof.value),
          },
        }),
      );
      return ok(
        requestView(
          {
            ...request,
            status: 'reverted',
            decision,
            decidedBy: admin,
            decidedAt: now,
            decisionReason: reason,
          },
          { accountId: admin, reviews: areas },
          now,
        ),
      );
    },
    { isolation: 'serializable' },
  );
  return labelled(deps, context, reverted);
}

/** `RejectSystemRequest`: another admin who reviews the area rejects; the value before returns. */
export const rejectRequest = (
  deps: SystemRequestsDependencies,
  context: CallContext,
  input: DecisionInput,
) => revertRequest(deps, context, 'reject', input);

/** `WithdrawSystemRequest`: the author reverts their own change. */
export const withdrawRequest = (
  deps: SystemRequestsDependencies,
  context: CallContext,
  input: DecisionInput,
) => revertRequest(deps, context, 'withdraw', input);

export const MAX_BULK = 100;

export interface BulkOutcome {
  readonly requestId: Id<'SystemRequest'>;
  /** `approved`, or the refusal's code for this one request. */
  readonly outcome: 'approved' | SystemRequestsFailure['code'];
}

/**
 * `ApproveSystemRequests`: bulk approve, low-risk requests only (Medium and High are opened and
 * reviewed one by one). Each request is decided in its own unit; one refusal does not stop the
 * others. Distinct ids, 1 to 100.
 */
export async function approveRequests(
  deps: SystemRequestsDependencies,
  context: CallContext,
  input: { readonly requestIds: unknown },
): Promise<Result<readonly BulkOutcome[], SystemRequestsFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const raw = input?.requestIds;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BULK) {
    return err(invalid([{ path: 'requestIds', code: 'length' }]));
  }
  const ids = raw.map(requestIdOf);
  if (ids.some((id) => id === null)) return err(invalid([{ path: 'requestIds', code: 'format' }]));
  if (new Set(ids).size !== ids.length) {
    return err(invalid([{ path: 'requestIds', code: 'duplicate' }]));
  }
  const areas = await reviewableAreas(deps, context);
  const outcomes: BulkOutcome[] = [];
  for (const id of ids as Id<'SystemRequest'>[]) {
    const result = await deps.unitOfWork.run<SystemRequest, SystemRequestsFailure>(
      context.market,
      async () => {
        const found = await decidable(deps, context, 'approve', admin, id);
        if (!found.ok) return found;
        if (found.value.risk !== 'low') return err({ code: 'system-requests.not-low-risk' });
        // A proposal is applied when approved, so it is approved one by one.
        if (found.value.mode !== 'review') return err({ code: 'system-requests.one-by-one' });
        if (!areas.has(found.value.area)) return err({ code: 'system-requests.not-reviewer' });
        return ok(await approveInUnit(deps, context, admin, found.value, null));
      },
    );
    outcomes.push({ requestId: id, outcome: result.ok ? 'approved' : result.error.code });
  }
  return ok(outcomes);
}
