import type { CallContext } from '@mondapac/shared-kernel';

/**
 * The display names of admin accounts, for the "acknowledged by" and "resolved by" lines of the
 * security centre. PERSONAL DATA for the admin who asked: never logged, stored, audited or put in an
 * event or an error body. An account the source cannot name (another Market's, a removed one) is
 * absent; a refusal answers an empty map, so the page shows the alert without names.
 */
export interface AdminNames {
  namesOf(
    context: CallContext,
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

export const ADMIN_NAMES = Symbol('ADMIN_NAMES');
