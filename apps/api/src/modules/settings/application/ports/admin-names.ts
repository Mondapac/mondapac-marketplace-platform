import type { CallContext } from '@mondapac/shared-kernel';

/** The display names of admin accounts, for "turned on by" lines. Never throws; unknown is absent. */
export interface AdminNames {
  namesOf(
    context: CallContext,
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}
export const SETTINGS_ADMIN_NAMES = Symbol('SETTINGS_ADMIN_NAMES');
