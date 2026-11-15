import type { InjectionToken, Provider } from '@nestjs/common';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { ChangeValues } from '../domain/request';

/**
 * What a reverter answers:
 * - `reverted`: the subject held `after` and now holds `before` again (written in the open unit);
 * - `changed-since`: the subject no longer holds `after` (someone changed it again), nothing
 *   was written;
 * - `gone`: the subject no longer exists, nothing was written.
 */
export type RevertOutcome = 'reverted' | 'changed-since' | 'gone';

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
}

/** The kinds and their reverters. Registration happens at boot and is sealed after it. */
export interface SystemChangeReverters {
  register(module: string, subjectKind: string, reverter: SystemChangeReverter): void;
  find(subjectKind: string): SystemChangeReverter | null;
}

export const SYSTEM_CHANGE_REVERTERS = Symbol('SYSTEM_CHANGE_REVERTERS');

/**
 * The one provider a module adds to register its reverter for `subjectKind` (whose first segment
 * must be the module's name): `registerSystemChangeReverter('settings', 'settings.market-setting',
 * SETTINGS_REVERTER)`, where the token resolves to a {@link SystemChangeReverter}.
 */
export function registerSystemChangeReverter(
  module: string,
  subjectKind: string,
  reverter: InjectionToken,
): Provider {
  return {
    provide: Symbol(`system-requests:reverter:${subjectKind}`),
    inject: [SYSTEM_CHANGE_REVERTERS, reverter],
    useFactory: (registry: SystemChangeReverters, implementation: SystemChangeReverter) => {
      registry.register(module, subjectKind, implementation);
      return subjectKind;
    },
  };
}
