import type { InjectionToken, Provider } from '@nestjs/common';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';

// The port of Admin Inbox › System requests (owner decisions of 15 Nov 2026), in platform so that
// every module of a reviewed area can reach it, identity included (identity imports no other
// module: ADR-0018 decision 4, ADR-0020 A9; modules implement or use platform's ports instead).
// The system-requests module implements the recorder and the reverter registry and re-exports
// this file from its contracts, so other modules keep importing it from there.

/**
 * The areas a change can be reviewed in. The same list as system-requests' `POLICY_AREAS`
 * (asserted by its spec).
 */
export type ChangeReviewArea =
  'people' | 'money' | 'delivery' | 'catalogue' | 'certification' | 'marketplace' | 'content';

/** A change's risk; the same list as system-requests' `RISKS`. */
export type ChangeReviewRisk = 'low' | 'medium' | 'high';

/** One value of a change: plain JSON (system-requests' `ChangeValue`). */
export type ChangeReviewValue =
  | string
  | number
  | boolean
  | null
  | readonly ChangeReviewValue[]
  | { readonly [field: string]: ChangeReviewValue };

/** The values of a change: a flat or nested object (system-requests' `ChangeValues`). */
export type ChangeReviewValues = { readonly [field: string]: ChangeReviewValue };

/**
 * A change an admin just made in another module's area, as that module hands it over. The
 * change is already written (it goes live at once; owner decision of 15 Nov 2026), in the open
 * unit that also calls {@link SystemRequestRecorder.openReview}.
 */
export interface AppliedChange {
  readonly area: ChangeReviewArea;
  /**
   * `<module>.<subject>`, the kind the owning module registered a reverter for (see
   * `registerSystemChangeReverter`): it restores `before` when a reviewer rejects the change.
   */
  readonly subjectKind: string;
  /** Which item of the kind changed (a setting code, a role id, ...); `[A-Za-z0-9._:-]`, 128 at most. */
  readonly subjectRef: string;
  /** The values before and after the change (see `isChangeReviewValues`; never a secret). */
  readonly before: ChangeReviewValues;
  readonly after: ChangeReviewValues;
  /**
   * The admin's note from the save dialog, as received: checked here (1 to 500 characters), and
   * only when the area is reviewed in the Market (pass whatever the request carried, even none).
   */
  readonly note: unknown;
  /** Raises the change's risk above the area's default risk; never lowers it. */
  readonly risk?: ChangeReviewRisk;
}

export interface RecordedRequest {
  readonly id: Id<'SystemRequest'>;
  /** Shown as SR-<number>. */
  readonly number: number;
  readonly risk: ChangeReviewRisk;
  readonly reviewDueAt: Temporal.Instant;
}

export type RecordFailure =
  /** The note is missing or too long (path `note`); the module refuses its own change. */
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  /** Not a signed-in admin acting as themselves. */
  | { readonly code: 'access.denied' };

/**
 * How a module of a reviewed area opens the review of a change (Admin Inbox › System requests).
 *
 * A named exception to "units do not nest": `openReview` opens no unit. It runs inside the caller's
 * open read-write unit, as the audit writer does, and writes only system-requests' own tables
 * through system-requests' own repository, so the change and its review commit or roll back
 * together. The caller writes its change first, then calls `openReview`; an `err` answer is the
 * caller's own refusal (it returns it, and its unit commits nothing).
 *
 * The caller holds its subject's row lock (or an equal lock) when it calls: two changes of one
 * subject must open their requests one after the other, so the later one supersedes the earlier.
 * `subjectKind` must be registered in `area` (see `registerSystemChangeReverter`), or this throws.
 *
 * The answer is `ok(null)` when the area is not reviewed in the context's Market (the change
 * stays live and nothing is opened), else the new request. A later change of the same subject
 * supersedes the earlier requests: they can no longer be reverted.
 */
export interface SystemRequestRecorder {
  openReview(
    context: CallContext,
    change: AppliedChange,
  ): Promise<Result<RecordedRequest | null, RecordFailure>>;

  /**
   * Whether the area is reviewed in the context's Market and at which risk: the page asks for a
   * note on save only when it is. Opens a read-only unit of its own (never inside the caller's);
   * a store that cannot be read answers the area's default.
   */
  areaPolicy(
    context: CallContext,
    area: ChangeReviewArea,
  ): Promise<{ readonly enabled: boolean; readonly risk: ChangeReviewRisk }>;
}

export const SYSTEM_REQUEST_RECORDER = Symbol('SYSTEM_REQUEST_RECORDER');

/**
 * What a reverter answers:
 * - `reverted`: the subject held `after` and now holds `before` again (written in the open unit);
 * - `changed-since`: the subject no longer holds `after` (someone changed it again), nothing
 *   was written;
 * - `gone`: the subject no longer exists, nothing was written;
 * - `not-permitted`: the deciding admin may not make this change in the owning module (for
 *   example a revert that would switch AI back on without the AI setting's own key), nothing
 *   was written.
 */
export type RevertOutcome = 'reverted' | 'changed-since' | 'gone' | 'not-permitted';

export interface RevertRequest {
  readonly requestId: Id<'SystemRequest'>;
  readonly subjectRef: string;
  readonly before: ChangeReviewValues;
  readonly after: ChangeReviewValues;
}

/**
 * Restores the value before a reviewed change, for one subject kind, owned by the module that
 * owns the subject (it writes its own tables, its own history and its own audit row). Runs inside
 * system-requests' open read-write unit, which also closes the request, so both commit or neither
 * does (the same named exception as `SystemRequestRecorder.openReview`). It must compare the current
 * value with `after` first and answer `changed-since` when they differ, and it must not open a
 * new review request: the revert closes this one.
 */
export interface SystemChangeReverter {
  revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome>;
}

/**
 * Where a module registers its kinds, at boot (sealed after it). A kind belongs to one reviewed
 * area: `openReview` refuses a change of that kind filed under another area. Register only:
 * nothing outside system-requests can look a reverter up.
 */
export interface SystemChangeReverters {
  register(
    module: string,
    subjectKind: string,
    area: ChangeReviewArea,
    reverter: SystemChangeReverter,
  ): void;
}

export const SYSTEM_CHANGE_REVERTERS = Symbol('SYSTEM_CHANGE_REVERTERS');

/**
 * The one provider a module adds to register its reverter for `subjectKind` (whose first segment
 * must be the module's name) in its reviewed area: `registerSystemChangeReverter('settings',
 * 'settings.market-setting', 'marketplace', SETTINGS_REVERTER)`, where the token resolves to a
 * {@link SystemChangeReverter}.
 */
export function registerSystemChangeReverter(
  module: string,
  subjectKind: string,
  area: ChangeReviewArea,
  reverter: InjectionToken,
): Provider {
  return {
    provide: Symbol(`system-requests:reverter:${subjectKind}`),
    inject: [SYSTEM_CHANGE_REVERTERS, reverter],
    useFactory: (registry: SystemChangeReverters, implementation: SystemChangeReverter) => {
      registry.register(module, subjectKind, area, implementation);
      return subjectKind;
    },
  };
}
