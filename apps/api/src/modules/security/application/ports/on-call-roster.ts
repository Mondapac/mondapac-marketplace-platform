import type { OnCallRoster } from '../../domain/roster';

/**
 * The on-call roster of this Region Stack, or null when none is configured (SECURITY_ON_CALL_FILE
 * unset): alerts are still opened and shown, and every delivery is recorded as `not-configured`.
 * A configured file that does not parse fails at boot.
 */
export interface OnCallRosterSource {
  roster(): OnCallRoster | null;
}

export const ON_CALL_ROSTER = Symbol('ON_CALL_ROSTER');
