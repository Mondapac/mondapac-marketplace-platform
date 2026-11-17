import type { Temporal } from '@mondapac/shared-kernel';
import type { AlertKeyType } from './rules';
import type { SecuritySeverity } from './severity';

// An alert and its life (design D2 and package 2): open -> acknowledged -> resolved, or open ->
// resolved. Acknowledging stops the escalation; only the incident commander or the security owner
// resolves an s1 alert; a resolved alert never changes (database trigger).

export type AlertState = 'open' | 'acknowledged' | 'resolved';
export const ALERT_STATES: readonly AlertState[] = ['open', 'acknowledged', 'resolved'];

/** How an alert ended. */
export const ALERT_RESOLUTIONS = [
  'contained',
  'false-positive',
  'duplicate',
  'accepted-risk',
] as const;
export type AlertResolution = (typeof ALERT_RESOLUTIONS)[number];

export const RESOLUTION_NOTE_MIN = 10;
export const RESOLUTION_NOTE_MAX = 1000;

export interface SecurityAlert {
  readonly id: string;
  readonly rule: string;
  readonly severity: SecuritySeverity;
  readonly state: AlertState;
  readonly keyType: AlertKeyType;
  readonly keyValue: string;
  readonly eventCount: number;
  readonly firstEventAt: Temporal.Instant;
  readonly lastEventAt: Temporal.Instant;
  readonly openedAt: Temporal.Instant;
  readonly notifyStep: number;
  readonly nextNotifyAt: Temporal.Instant | null;
  readonly acknowledgedAt: Temporal.Instant | null;
  readonly acknowledgedBy: string | null;
  readonly resolvedAt: Temporal.Instant | null;
  readonly resolvedBy: string | null;
  readonly resolution: AlertResolution | null;
  readonly resolutionNote: string | null;
  readonly version: number;
}

export type AlertTransitionRefusal =
  /** The alert is not in a state the transition starts from. */
  | 'security.alert-state'
  /** s1: only the incident commander or the security owner resolves (D2). */
  | 'security.s1-resolver-only';

export function acknowledgeAlert(
  alert: SecurityAlert,
  by: string,
  at: Temporal.Instant,
): SecurityAlert | AlertTransitionRefusal {
  if (alert.state !== 'open') return 'security.alert-state';
  return {
    ...alert,
    state: 'acknowledged',
    acknowledgedAt: at,
    acknowledgedBy: by,
    nextNotifyAt: null,
    version: alert.version + 1,
  };
}

export function resolveAlert(
  alert: SecurityAlert,
  input: {
    readonly by: string;
    readonly at: Temporal.Instant;
    readonly resolution: AlertResolution;
    readonly note: string;
    /** The admin accounts that may resolve an s1 alert (the roster's commander and owner). */
    readonly s1Resolvers: readonly string[];
  },
): SecurityAlert | AlertTransitionRefusal {
  if (alert.state === 'resolved') return 'security.alert-state';
  if (alert.severity === 's1' && !input.s1Resolvers.includes(input.by)) {
    return 'security.s1-resolver-only';
  }
  return {
    ...alert,
    state: 'resolved',
    resolvedAt: input.at,
    resolvedBy: input.by,
    resolution: input.resolution,
    resolutionNote: input.note,
    nextNotifyAt: null,
    version: alert.version + 1,
  };
}

/** A resolution note: trimmed, 10 to 1000 characters, no control characters. */
export function normaliseNote(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const note = value.trim();
  const length = Array.from(note).length;
  if (length < RESOLUTION_NOTE_MIN || length > RESOLUTION_NOTE_MAX) return null;
  // Control characters other than a line feed or a tab (they could forge lines in a viewer).
  for (const char of note) {
    const code = char.codePointAt(0)!;
    if ((code < 0x20 && char !== '\n' && char !== '\t') || (code >= 0x7f && code <= 0x9f)) {
      return null;
    }
  }
  return note;
}
