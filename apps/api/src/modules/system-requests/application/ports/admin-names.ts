import type { CallContext } from '@mondapac/shared-kernel';

/**
 * The display names of admin accounts (identity's `changeActors`), for the "requested by",
 * "decided by" and history lines of System requests. PERSONAL DATA for the admin who asked: never
 * logged, stored, audited or put in an event or an error body. An account the source cannot name
 * is absent; a refusal or a failure answers an empty map, so the page shows ids without names.
 * Called outside any unit, with the caller's `CallContext` unchanged.
 */
export interface AdminNames {
  namesOf(
    context: CallContext,
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

export const ADMIN_NAMES = Symbol('SYSTEM_REQUESTS_ADMIN_NAMES');
