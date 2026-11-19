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
   * {@link SystemChangeRegistrar.reverter}): it restores `before` when a reviewer rejects the change.
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

/**
 * An action an admin asked for that waits for another admin's approval before it is applied
 * (see {@link SystemRequestRecorder.proposeChange}). `before` is what the subject holds now (shown
 * to the reviewer, and compared again by the applier); `after` describes the action (for example
 * `{action: 'delete'}` or `{action: 'merge', intoId, intoName}`), in the owning module's own shape.
 */
export interface ProposedChange {
  readonly area: ChangeReviewArea;
  readonly subjectKind: string;
  readonly subjectRef: string;
  readonly before: ChangeReviewValues;
  readonly after: ChangeReviewValues;
  readonly note: unknown;
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

export type ProposeFailure =
  | RecordFailure
  /**
   * The subject already has a proposal waiting for approval (its number in `pendingNumber`); the
   * module refuses the new one and changes nothing.
   */
  | { readonly code: 'system-requests.already-pending'; readonly pendingNumber: number };

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
 * `subjectKind` must be registered in `area` (see {@link SystemChangeRegistrar.reverter}), or this throws.
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
 * How a module files an action that waits for approval (owner decision of 18 Nov 2026); the same
 * implementation as {@link SystemRequestRecorder}, under its own token. Use `areaPolicy` of the
 * recorder to know whether the page asks for a note.
 */
export interface SystemActionProposer {
  /**
   * How a module of a reviewed area files an action that is applied only once another admin
   * approves it: a delete, a merge or an import (owner decision of 18 Nov 2026). Nothing is
   * written by the owning module now. Runs inside the caller's open read-write unit, as
   * `openReview` does; the caller has checked the admin's permission and validated the action as
   * it would before applying it, and holds the subject's row lock.
   *
   * `subjectKind` must be registered with an applier (see {@link SystemChangeRegistrar.applier}), or this
   * throws. The answer is `ok(null)` when the area is not reviewed in the context's Market: the
   * caller then applies the action at once, in the same unit, as it did before. Otherwise the new
   * request; its approval runs the kind's {@link SystemChangeApplier.apply}. One proposal waits per
   * subject: a second is `system-requests.already-pending`.
   */
  proposeChange(
    context: CallContext,
    change: ProposedChange,
  ): Promise<Result<RecordedRequest | null, ProposeFailure>>;
}

export const SYSTEM_ACTION_PROPOSER = Symbol('SYSTEM_ACTION_PROPOSER');

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

  /**
   * Optional separation-of-duties check: whether the change is about the deciding admin (their
   * own account, a role they hold, ...), so they may neither approve nor reject it
   * (`system-requests.own-subject`). Runs inside the decision's open unit and must open none; a
   * module without it lets any reviewer but the author decide.
   */
  isInterested?(context: CallContext, request: RevertRequest): Promise<boolean>;

  /**
   * Optional: the checks of the owning module's own edit that cannot run inside the decision unit
   * because they open a unit of their own (the decider holding the subject's edit permission,
   * reference checks against another module, Market data that can change over time). Called by
   * system-requests before the decision unit opens, for a reject or a withdraw only; it must fail
   * closed. `not-permitted` writes nothing and leaves the request open. `revert` still checks what
   * it can inside the unit.
   */
  check?(context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'>;

  /**
   * Optional: a short human label of each subject (a store name, a setting's name), shown in the
   * System requests queue beside the kind (`subjectLabel`). Called outside any unit (a reverter
   * that reads opens its own read-only unit or calls a facade), with the viewing admin's
   * `CallContext` unchanged, once per kind per page, at most {@link MAX_DESCRIBE_REFS} refs per
   * call. A ref it cannot or may not name is left out. Every admin who sees the queue sees the
   * label, so it names the subject only: never a value of the change, a secret or a sign-in
   * address. A throw or a malformed label shows no label; it never fails the page.
   */
  describe?(
    context: CallContext,
    subjectRefs: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

/**
 * What an applier answers:
 * - `applied`: the subject still held `before` and the action is now done (written in the open
 *   unit);
 * - `changed-since`: the subject no longer holds `before`, nothing was written;
 * - `gone`: the subject no longer exists, nothing was written;
 * - `not-permitted`: the approving admin may not make this change in the owning module, or the
 *   owning module's own rules refuse it now, nothing was written.
 */
export type ApplyOutcome = 'applied' | 'changed-since' | 'gone' | 'not-permitted';

/**
 * Applies an approved proposal (see {@link SystemRequestRecorder.proposeChange}), for one subject
 * kind, owned by the module that owns the subject (it writes its own tables, history, audit row
 * and events, as the approving admin, naming the request). Runs inside system-requests' open
 * serializable read-write unit, which also closes the request, so both commit or neither does.
 * It must compare the subject with `before` first and run every check its own use case runs
 * (validation, references, guards) except the caller's permissions, which system-requests (the
 * key registered with the applier) and `check` cover. A reject or withdraw of a proposal asks the
 * applier nothing: nothing was applied.
 */
export interface SystemChangeApplier {
  apply(context: CallContext, request: RevertRequest): Promise<ApplyOutcome>;
  /** As {@link SystemChangeReverter.isInterested}, for an approval. */
  isInterested?(context: CallContext, request: RevertRequest): Promise<boolean>;
  /**
   * The checks of the action that open a unit of their own, run before the approval's unit
   * opens (system-requests has already checked the permission key registered with the applier):
   * any further permission or rule of the owning module's use case, reference checks against
   * another module. Must fail closed; `not-permitted` writes nothing and leaves the request open.
   */
  check(context: CallContext, request: RevertRequest): Promise<'ok' | 'not-permitted'>;
  /** As {@link SystemChangeReverter.describe}. */
  describe?(
    context: CallContext,
    subjectRefs: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

/** The most subject refs one {@link SystemChangeReverter.describe} call is asked for. */
export const MAX_DESCRIBE_REFS = 100;

/**
 * Where a module's registrar registers its kinds, at boot (sealed after it). A kind belongs to one
 * reviewed area: `openReview` refuses a change of that kind filed under another area. Register
 * only: nothing outside system-requests can look a reverter up. A module never calls this itself:
 * it adds the providers of its own {@link SystemChangeRegistrar}, which pass the registrar (not a
 * module name), so system-requests binds each kind to the module that holds the registrar.
 */
export interface SystemChangeReverters {
  register(
    registrar: SystemChangeRegistrar,
    subjectKind: string,
    area: ChangeReviewArea,
    reverter: SystemChangeReverter,
  ): void;
  /**
   * As `register`, for a kind whose actions wait for approval (`proposeChange`). `permission` is
   * the key the action needs, or every key when the owning module's use case declares several
   * (`allOf`): system-requests checks that the approving admin holds them all before the approval,
   * whatever the applier's `check` answers.
   */
  registerApplier(
    registrar: SystemChangeRegistrar,
    subjectKind: string,
    area: ChangeReviewArea,
    permission: string | readonly string[],
    applier: SystemChangeApplier,
  ): void;
}

export const SYSTEM_CHANGE_REVERTERS = Symbol('SYSTEM_CHANGE_REVERTERS');

/**
 * A module's own registration facade for System requests: created once per module, in a file of
 * that module that its public barrel never exports, with {@link createSystemChangeRegistrar}. It
 * registers kinds only under the module's own name and kind prefix (`<module>.`); system-requests
 * also refuses, at boot, a second registrar of the same module name, a kind registered twice and
 * an area the module does not own. Every refusal throws while the application starts, never at
 * request time.
 */
export interface SystemChangeRegistrar {
  /** The module the registrar was created for (the first segment of each of its kinds). */
  readonly module: string;
  /**
   * The provider that registers the reverter of `subjectKind` (`<module>.<subject>`) in its
   * reviewed area, where the token resolves to a {@link SystemChangeReverter}:
   * `SETTINGS_SYSTEM_CHANGES.reverter('settings.market-setting', 'marketplace', SETTINGS_REVERTER)`.
   */
  reverter(subjectKind: string, area: ChangeReviewArea, reverter: InjectionToken): Provider;
  /**
   * The provider that registers the applier of `subjectKind` (see {@link SystemChangeApplier}),
   * with the permission key the action needs (or every key its use case declares, as an array):
   * `CATALOG_SYSTEM_CHANGES.applier('catalog.category-discard', 'catalogue',
   * CATALOG_CATEGORY_TREE_EDIT.key, CATEGORY_DISCARD_APPLIER)`.
   */
  applier(
    subjectKind: string,
    area: ChangeReviewArea,
    permission: string | readonly string[],
    applier: InjectionToken,
  ): Provider;
}

/** A module name: the first segment of its kinds. */
const MODULE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The registrars {@link createSystemChangeRegistrar} made, each with the place it was created (a
 * stack line), so a refused second registrar names both: a copy or a hand-made object is none.
 */
const registrars = new WeakMap<SystemChangeRegistrar, string>();

/** The caller of `createSystemChangeRegistrar`: the stack line after this file's own frames. */
function creationSite(): string {
  const lines = (new Error().stack ?? '').split('\n').slice(1);
  const outside = lines.find((line) => !line.includes('change-review'));
  return outside?.trim().replace(/^at\s+/, '') ?? 'unknown';
}

/** A registrar refused while the module files load: a bad module name or another module's kind. */
export class SystemChangeRegistrarError extends Error {
  override readonly name = 'SystemChangeRegistrarError';
}

/**
 * Creates `module`'s registrar. Call it once, in one file of the module (a module constant such
 * as `CATALOG_SYSTEM_CHANGES`), and never export it from the module's barrel: the registrar is
 * the module's identity towards System requests. A kind outside `<module>.` throws at once.
 */
export function createSystemChangeRegistrar(module: string): SystemChangeRegistrar {
  if (typeof module !== 'string' || !MODULE_NAME.test(module)) {
    throw new SystemChangeRegistrarError(`${JSON.stringify(module)} is not a module name`);
  }
  const ownKind = (subjectKind: string): string => {
    if (typeof subjectKind !== 'string' || !subjectKind.startsWith(`${module}.`)) {
      throw new SystemChangeRegistrarError(
        `Module "${module}" cannot register ${JSON.stringify(subjectKind)}: its kinds start with "${module}."`,
      );
    }
    return subjectKind;
  };
  const registrar: SystemChangeRegistrar = Object.freeze({
    module,
    reverter: (subjectKind: string, area: ChangeReviewArea, reverter: InjectionToken): Provider => {
      const kind = ownKind(subjectKind);
      return {
        provide: Symbol(`system-requests:reverter:${kind}`),
        inject: [SYSTEM_CHANGE_REVERTERS, reverter],
        useFactory: (registry: SystemChangeReverters, implementation: SystemChangeReverter) => {
          registry.register(registrar, kind, area, implementation);
          return kind;
        },
      };
    },
    applier: (
      subjectKind: string,
      area: ChangeReviewArea,
      permission: string | readonly string[],
      applier: InjectionToken,
    ): Provider => {
      const kind = ownKind(subjectKind);
      return {
        provide: Symbol(`system-requests:applier:${kind}`),
        inject: [SYSTEM_CHANGE_REVERTERS, applier],
        useFactory: (registry: SystemChangeReverters, implementation: SystemChangeApplier) => {
          registry.registerApplier(registrar, kind, area, permission, implementation);
          return kind;
        },
      };
    },
  });
  registrars.set(registrar, creationSite());
  return registrar;
}

/** Whether `value` is a registrar {@link createSystemChangeRegistrar} made (for system-requests). */
export function isSystemChangeRegistrar(value: unknown): value is SystemChangeRegistrar {
  return (
    typeof value === 'object' && value !== null && registrars.has(value as SystemChangeRegistrar)
  );
}

/** Where a registrar was created (a stack line), for a boot error; `unknown` for anything else. */
export function systemChangeRegistrarSite(registrar: SystemChangeRegistrar): string {
  return registrars.get(registrar) ?? 'unknown';
}
