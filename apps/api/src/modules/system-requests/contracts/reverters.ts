import type { InjectionToken, Provider } from '@nestjs/common';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { PolicyArea } from '../domain/areas';
import type { ChangeValues } from '../domain/request';

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
  readonly before: ChangeValues;
  readonly after: ChangeValues;
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

/** The most subject refs one {@link SystemChangeReverter.describe} call is asked for. */
export const MAX_DESCRIBE_REFS = 100;

/**
 * Where a module registers its kinds, at boot (sealed after it). A kind belongs to one reviewed
 * area: `openReview` refuses a change of that kind filed under another area. Register only:
 * nothing outside system-requests can look a reverter up.
 */
export interface SystemChangeReverters {
  register(
    module: string,
    subjectKind: string,
    area: PolicyArea,
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
  area: PolicyArea,
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
