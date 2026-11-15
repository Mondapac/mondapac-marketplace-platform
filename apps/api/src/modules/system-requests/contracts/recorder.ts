import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { PolicyArea, Risk } from '../domain/areas';
import type { ChangeValues } from '../domain/request';

/**
 * A change an admin just made in another module's area, as that module hands it over. The
 * change is already written (it goes live at once; owner decision of 15 Nov 2026), in the open
 * unit that also calls {@link SystemRequestRecorder.openReview}.
 */
export interface AppliedChange {
  readonly area: PolicyArea;
  /**
   * `<module>.<subject>`, the kind the owning module registered a reverter for (see
   * `registerSystemChangeReverter`): it restores `before` when a reviewer rejects the change.
   */
  readonly subjectKind: string;
  /** Which item of the kind changed (a setting code, a role id, ...); `[A-Za-z0-9._:-]`, 128 at most. */
  readonly subjectRef: string;
  /** The values before and after the change (see `isChangeValues`; never a secret). */
  readonly before: ChangeValues;
  readonly after: ChangeValues;
  /**
   * The admin's note from the save dialog, as received: checked here (1 to 500 characters), and
   * only when the area is reviewed in the Market (pass whatever the request carried, even none).
   */
  readonly note: unknown;
  /** Raises the change's risk above the area's default risk; never lowers it. */
  readonly risk?: Risk;
}

export interface RecordedRequest {
  readonly id: Id<'SystemRequest'>;
  /** Shown as SR-<number>. */
  readonly number: number;
  readonly risk: Risk;
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
    area: PolicyArea,
  ): Promise<{ readonly enabled: boolean; readonly risk: Risk }>;
}

export const SYSTEM_REQUEST_RECORDER = Symbol('SYSTEM_REQUEST_RECORDER');
