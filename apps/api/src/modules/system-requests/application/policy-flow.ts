import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type {
  RevertOutcome,
  RevertRequest,
  SystemChangeReverter,
} from '../../../platform/change-review/change-review';
import { SYSTEM_REQUESTS_POLICY_CHANGE_STEP_UP } from '../contracts/step-up';
import {
  AREA_DEFAULTS,
  DEFAULT_REVIEW_DUE_DAYS,
  isPolicyArea,
  isRisk,
  MAX_REVIEW_DUE_DAYS,
  MIN_REVIEW_DUE_DAYS,
  POLICY_AREAS,
  type PolicyArea,
  type Risk,
} from '../domain/areas';
import { PolicyChanged } from '../domain/audit';
import { checkText, MAX_NOTE } from '../domain/request';
import type { RecordedRequest } from '../contracts/recorder';
import {
  adminNamesOf,
  openInUnit,
  signedInAdmin,
  stepUpFailure,
  type FieldIssue,
  type SystemRequestsFailure,
} from './request-flow';
import { REVIEW_KEYS } from './review-keys';
import type { SystemRequestsDependencies } from './system-requests-dependencies';

// The review policy (Settings › People › Review policy): per area, whether a change is reviewed
// and its default risk; and the review period after which an open request is overdue. A change to
// the policy is itself reviewed, always as high risk, by the people reviewers (nobody turns review
// off quietly), spends a fresh admin step-up proof, checks the version the admin saw, and is
// audited. Its reverter restores the value before when a reviewer rejects it.

/** The subject kinds of the review policy's own requests. */
export const POLICY_AREA_KIND = 'system-requests.policy-area';
export const DUE_DAYS_KIND = 'system-requests.review-due-days';
/** The subject key of the review period (one per Market). */
export const DUE_DAYS_KEY = 'market';

/** The English names of the policy areas, for the queue's subject label ("Money review"). */
const POLICY_AREA_LABELS: Readonly<Record<PolicyArea, string>> = Object.freeze({
  people: 'People',
  money: 'Money',
  delivery: 'Delivery',
  catalogue: 'Catalogue',
  certification: 'Certification',
  marketplace: 'Marketplace',
  content: 'Content',
});

export interface AreaPolicyView {
  readonly area: PolicyArea;
  readonly enabled: boolean;
  readonly risk: Risk;
  readonly reviewPermission: string;
  /** 0 while the default is in force. */
  readonly version: number;
  readonly updatedAt: Temporal.Instant | null;
  readonly updatedBy: Id<'Account'> | null;
  /** The display name of `updatedBy` (identity's facade); null when unknown or unreadable. */
  readonly updatedByName: string | null;
}

export interface DueDaysView {
  readonly reviewDueDays: number;
  readonly version: number;
  readonly updatedAt: Temporal.Instant | null;
  readonly updatedBy: Id<'Account'> | null;
  /** The display name of `updatedBy`; null when unknown or unreadable. */
  readonly updatedByName: string | null;
}

/** Adds `updatedByName` to stamped values, after the unit; null where a name cannot be read. */
async function namedStamps<T extends { readonly updatedBy: Id<'Account'> | null }>(
  deps: SystemRequestsDependencies,
  context: CallContext,
  values: readonly T[],
): Promise<T[]> {
  const names = await adminNamesOf(
    deps,
    context,
    values.map((value) => value.updatedBy),
  );
  return values.map((value) => ({
    ...value,
    updatedByName: value.updatedBy === null ? null : (names.get(value.updatedBy) ?? null),
  }));
}

async function namedChange<T extends { readonly updatedBy: Id<'Account'> | null }>(
  deps: SystemRequestsDependencies,
  context: CallContext,
  result: Result<PolicyChangeView<T>, SystemRequestsFailure>,
): Promise<Result<PolicyChangeView<T>, SystemRequestsFailure>> {
  if (!result.ok) return result;
  const [value] = await namedStamps(deps, context, [result.value.value]);
  return ok({ ...result.value, value: value! });
}

export interface PolicyView {
  readonly areas: readonly AreaPolicyView[];
  readonly reviewDueDays: DueDaysView;
  /** The review policy's own row: always reviewed, high risk, by the people reviewers. */
  readonly reviewPolicy: { readonly risk: 'high'; readonly reviewPermission: string };
}

export interface PolicyChangeView<T> {
  readonly value: T;
  /** The review request the change opened. */
  readonly request: RecordedRequest | null;
}

/** `ViewReviewPolicy`: every area's policy and the review period, defaults included. */
export async function viewPolicy(
  deps: SystemRequestsDependencies,
  context: CallContext,
): Promise<Result<PolicyView, SystemRequestsFailure>> {
  if (signedInAdmin(context) === null) return err({ code: 'access.denied' });
  const read = await deps.unitOfWork.run<PolicyView, SystemRequestsFailure>(
    context.market,
    async () => {
      const rows = await deps.policy.areas(context.market);
      const due = await deps.policy.dueDays(context.market);
      return ok({
        areas: POLICY_AREAS.map((area) => {
          const row = rows.find((candidate) => candidate.area === area);
          return {
            area,
            enabled: row?.enabled ?? AREA_DEFAULTS[area].enabled,
            risk: row?.risk ?? AREA_DEFAULTS[area].risk,
            reviewPermission: REVIEW_KEYS[area],
            version: row?.version ?? 0,
            updatedAt: row?.updatedAt ?? null,
            updatedBy: row?.updatedBy ?? null,
            updatedByName: null,
          };
        }),
        reviewDueDays: {
          reviewDueDays: due?.reviewDueDays ?? DEFAULT_REVIEW_DUE_DAYS,
          version: due?.version ?? 0,
          updatedAt: due?.updatedAt ?? null,
          updatedBy: due?.updatedBy ?? null,
          updatedByName: null,
        },
        reviewPolicy: { risk: 'high', reviewPermission: REVIEW_KEYS['review-policy'] },
      });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  // One names read for the page, after the unit (P 3.1 row 5).
  const names = await adminNamesOf(deps, context, [
    ...read.value.areas.map((area) => area.updatedBy),
    read.value.reviewDueDays.updatedBy,
  ]);
  const nameOf = (id: Id<'Account'> | null) => (id === null ? null : (names.get(id) ?? null));
  return ok({
    ...read.value,
    areas: read.value.areas.map((area) => ({ ...area, updatedByName: nameOf(area.updatedBy) })),
    reviewDueDays: {
      ...read.value.reviewDueDays,
      updatedByName: nameOf(read.value.reviewDueDays.updatedBy),
    },
  });
}

const versionOk = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** `ChangeAreaReviewPolicy`: turn an area's review on or off, or change its default risk. */
export async function changeAreaPolicy(
  deps: SystemRequestsDependencies,
  context: CallContext,
  input: {
    readonly area: unknown;
    readonly enabled: unknown;
    readonly risk: unknown;
    readonly expectedVersion: unknown;
    readonly note: unknown;
  },
): Promise<Result<PolicyChangeView<AreaPolicyView>, SystemRequestsFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const fields: FieldIssue[] = [];
  if (!isPolicyArea(input?.area)) fields.push({ path: 'area', code: 'value' });
  if (typeof input?.enabled !== 'boolean') fields.push({ path: 'enabled', code: 'type' });
  if (!isRisk(input?.risk)) fields.push({ path: 'risk', code: 'value' });
  if (!versionOk(input?.expectedVersion)) fields.push({ path: 'expectedVersion', code: 'type' });
  const note = checkText(input?.note, MAX_NOTE);
  if (!note.ok) fields.push({ path: 'note', code: note.code });
  if (fields.length > 0 || !note.ok) return err({ code: 'validation.failed', fields });
  const area = input.area as PolicyArea;
  const next = { enabled: input.enabled as boolean, risk: input.risk as Risk };
  const seen = input.expectedVersion as number;

  const changed = await deps.unitOfWork.run<
    PolicyChangeView<AreaPolicyView>,
    SystemRequestsFailure
  >(context.market, async () => {
    const row = await deps.policy.area(context.market, area);
    const version = row?.version ?? 0;
    if (version !== seen) return err({ code: 'system-requests.policy-conflict' });
    const was = row === null ? AREA_DEFAULTS[area] : { enabled: row.enabled, risk: row.risk };
    const unchanged: AreaPolicyView = {
      area,
      ...was,
      reviewPermission: REVIEW_KEYS[area],
      version,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
      updatedByName: null,
    };
    if (was.enabled === next.enabled && was.risk === next.risk) {
      return ok({ value: unchanged, request: null });
    }
    const spent = await deps.stepUp.consume(context, SYSTEM_REQUESTS_POLICY_CHANGE_STEP_UP);
    if (!spent.ok) return err(stepUpFailure(spent.error));
    const now = deps.clock.now();
    const written = await deps.policy.setArea(context.market, area, next, {
      version: version + 1,
      at: now,
      by: admin,
    });
    if (!written) return err({ code: 'system-requests.policy-conflict' });
    const request = await openInUnit(deps, context, admin, {
      area: 'review-policy',
      subjectKind: POLICY_AREA_KIND,
      subjectRef: area,
      before: { enabled: was.enabled, risk: was.risk },
      after: { enabled: next.enabled, risk: next.risk },
      note: note.text,
    });
    await deps.audit.record(
      context,
      PolicyChanged.entry(area, {
        before: { enabled: was.enabled, risk: was.risk, reviewDueDays: null },
        after: {
          enabled: next.enabled,
          risk: next.risk,
          reviewDueDays: null,
          version: version + 1,
          requestId: request?.id ?? null,
        },
      }),
    );
    return ok({
      value: { ...unchanged, ...next, version: version + 1, updatedAt: now, updatedBy: admin },
      request,
    });
  });
  return namedChange(deps, context, changed);
}

/** `ChangeReviewDueDays`: after how many days an open request is overdue (1 to 90). */
export async function changeDueDays(
  deps: SystemRequestsDependencies,
  context: CallContext,
  input: {
    readonly reviewDueDays: unknown;
    readonly expectedVersion: unknown;
    readonly note: unknown;
  },
): Promise<Result<PolicyChangeView<DueDaysView>, SystemRequestsFailure>> {
  const admin = signedInAdmin(context);
  if (admin === null) return err({ code: 'access.denied' });
  const fields: FieldIssue[] = [];
  const days = input?.reviewDueDays;
  if (
    !Number.isSafeInteger(days) ||
    (days as number) < MIN_REVIEW_DUE_DAYS ||
    (days as number) > MAX_REVIEW_DUE_DAYS
  ) {
    fields.push({ path: 'reviewDueDays', code: 'range' });
  }
  if (!versionOk(input?.expectedVersion)) fields.push({ path: 'expectedVersion', code: 'type' });
  const note = checkText(input?.note, MAX_NOTE);
  if (!note.ok) fields.push({ path: 'note', code: note.code });
  if (fields.length > 0 || !note.ok) return err({ code: 'validation.failed', fields });
  const next = days as number;
  const seen = input.expectedVersion as number;

  const changed = await deps.unitOfWork.run<PolicyChangeView<DueDaysView>, SystemRequestsFailure>(
    context.market,
    async () => {
      const row = await deps.policy.dueDays(context.market);
      const version = row?.version ?? 0;
      if (version !== seen) return err({ code: 'system-requests.policy-conflict' });
      const was = row?.reviewDueDays ?? DEFAULT_REVIEW_DUE_DAYS;
      const unchanged: DueDaysView = {
        reviewDueDays: was,
        version,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
        updatedByName: null,
      };
      if (was === next) return ok({ value: unchanged, request: null });
      const spent = await deps.stepUp.consume(context, SYSTEM_REQUESTS_POLICY_CHANGE_STEP_UP);
      if (!spent.ok) return err(stepUpFailure(spent.error));
      const now = deps.clock.now();
      const written = await deps.policy.setDueDays(context.market, next, {
        version: version + 1,
        at: now,
        by: admin,
      });
      if (!written) return err({ code: 'system-requests.policy-conflict' });
      const request = await openInUnit(deps, context, admin, {
        area: 'review-policy',
        subjectKind: DUE_DAYS_KIND,
        subjectRef: DUE_DAYS_KEY,
        before: { reviewDueDays: was },
        after: { reviewDueDays: next },
        note: note.text,
      });
      await deps.audit.record(
        context,
        PolicyChanged.entry('review-due-days', {
          before: { enabled: null, risk: null, reviewDueDays: was },
          after: {
            enabled: null,
            risk: null,
            reviewDueDays: next,
            version: version + 1,
            requestId: request?.id ?? null,
          },
        }),
      );
      return ok({
        value: {
          reviewDueDays: next,
          version: version + 1,
          updatedAt: now,
          updatedBy: admin,
          updatedByName: null,
        },
        request,
      });
    },
  );
  return namedChange(deps, context, changed);
}

/**
 * Restores the review policy's value before a rejected or withdrawn change, in the open unit of
 * the decision. The reverting admin is the one who stamps the row. It opens no new request.
 */
export class PolicyReverter implements SystemChangeReverter {
  constructor(
    private readonly deps: SystemRequestsDependencies,
    private readonly kind: typeof POLICY_AREA_KIND | typeof DUE_DAYS_KIND,
  ) {}

  async revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    const admin = signedInAdmin(context);
    if (admin === null) throw new Error('system-requests: a revert needs a signed-in admin');
    const now = this.deps.clock.now();
    return this.kind === POLICY_AREA_KIND
      ? this.revertArea(context, admin, now, request)
      : this.revertDueDays(context, admin, now, request);
  }

  /** The policy's own labels: the area's name, or "Review period" for the due days. */
  describe(_context: CallContext, subjectRefs: readonly string[]) {
    const labels = new Map<string, string>();
    for (const ref of subjectRefs) {
      if (this.kind === DUE_DAYS_KIND) {
        if (ref === DUE_DAYS_KEY) labels.set(ref, 'Review period');
      } else if (Object.hasOwn(POLICY_AREA_LABELS, ref)) {
        labels.set(ref, `${POLICY_AREA_LABELS[ref as PolicyArea]} review`);
      }
    }
    return Promise.resolve(labels);
  }

  private async revertArea(
    context: CallContext,
    admin: Id<'Account'>,
    now: Temporal.Instant,
    request: RevertRequest,
  ): Promise<RevertOutcome> {
    const area = request.subjectRef;
    const { before, after } = request;
    if (
      !isPolicyArea(area) ||
      typeof before.enabled !== 'boolean' ||
      !isRisk(before.risk) ||
      typeof after.enabled !== 'boolean' ||
      !isRisk(after.risk)
    ) {
      return 'gone';
    }
    const row = await this.deps.policy.area(context.market, area);
    const current = row === null ? AREA_DEFAULTS[area] : { enabled: row.enabled, risk: row.risk };
    if (current.enabled !== after.enabled || current.risk !== after.risk) return 'changed-since';
    const version = (row?.version ?? 0) + 1;
    const restored = { enabled: before.enabled, risk: before.risk };
    const written = await this.deps.policy.setArea(context.market, area, restored, {
      version,
      at: now,
      by: admin,
    });
    if (!written) return 'changed-since';
    await this.deps.audit.record(
      context,
      PolicyChanged.entry(area, {
        before: { enabled: current.enabled, risk: current.risk, reviewDueDays: null },
        after: { ...restored, reviewDueDays: null, version, requestId: null },
      }),
    );
    return 'reverted';
  }

  private async revertDueDays(
    context: CallContext,
    admin: Id<'Account'>,
    now: Temporal.Instant,
    request: RevertRequest,
  ): Promise<RevertOutcome> {
    const { before, after } = request;
    const restore = before.reviewDueDays;
    if (
      request.subjectRef !== DUE_DAYS_KEY ||
      !Number.isSafeInteger(restore) ||
      (restore as number) < MIN_REVIEW_DUE_DAYS ||
      (restore as number) > MAX_REVIEW_DUE_DAYS
    ) {
      return 'gone';
    }
    const row = await this.deps.policy.dueDays(context.market);
    const current = row?.reviewDueDays ?? DEFAULT_REVIEW_DUE_DAYS;
    if (current !== after.reviewDueDays) return 'changed-since';
    const version = (row?.version ?? 0) + 1;
    const written = await this.deps.policy.setDueDays(context.market, restore as number, {
      version,
      at: now,
      by: admin,
    });
    if (!written) return 'changed-since';
    await this.deps.audit.record(
      context,
      PolicyChanged.entry('review-due-days', {
        before: { enabled: null, risk: null, reviewDueDays: current },
        after: {
          enabled: null,
          risk: null,
          reviewDueDays: restore as number,
          version,
          requestId: null,
        },
      }),
    );
    return 'reverted';
  }
}
