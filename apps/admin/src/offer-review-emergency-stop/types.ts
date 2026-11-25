// The Offer review emergency stop (R0; apps/api settings module): whether it is on, since when and
// who switched it. The panel shows what the API answers; it decides nothing.

export const EMERGENCY_STOP_PATH = 'settings/admin/offer-review/emergency-stop';
/** Protected: switching asks for a fresh two-step code. */
export const EMERGENCY_STOP_PERMISSION = 'settings.offer-review.emergency-stop';
export const EMERGENCY_STOP_HREF = '/settings/emergency-stop';
/** How often the banner reads the switch while the tab is visible. */
export const BANNER_POLL_MS = 60_000;
/** The API's note limit. */
export const MAX_REASON = 500;

export interface EmergencyStop {
  readonly on: boolean;
  readonly version: number;
  /** ISO instant of the last switch, null while the default is in force. */
  readonly changedAt: string | null;
  readonly changedBy: string | null;
}

/** The answer of the GET route, or null when it is not one. */
export function emergencyStopOf(body: unknown): EmergencyStop | null {
  if (typeof body !== 'object' || body === null) return null;
  const { on, version, changedAt, changedBy } = body as Record<string, unknown>;
  if (typeof on !== 'boolean' || typeof version !== 'number') return null;
  return {
    on,
    version,
    changedAt: typeof changedAt === 'string' ? changedAt : null,
    changedBy: typeof changedBy === 'string' && changedBy !== '' ? changedBy : null,
  };
}
