// Answers of the security centre API (GET/POST security/admin/*, SOC package 2) and what the
// pages share. Design: design/soc/security-centre-frontend-v3-fa.html (john's decisions F1-F4,
// 2026-11-15) with Reza's review (reza-review-security-centre-v3.md).

export const VIEW_PERMISSION = 'security.centre.view';
export const RESPOND_PERMISSION = 'security.alerts.respond';

/** F4: the alerts page reads again every 30 s, the top-bar badge every 60 s, while visible. */
export const PAGE_POLL_MS = 30_000;
export const BADGE_POLL_MS = 60_000;
export const PAGE_SIZE = 50;
/** The rules run every minute; past this the page says they have stopped. */
export const RULES_STALE_MS = 5 * 60_000;
/** Plan section 4: an s1 alert is answered within 15 minutes. */
export const S1_RESPONSE_MS = 15 * 60_000;
/** The API's s1 escalation limit, for when the on-call view could not be read. */
export const S1_MAX_STEPS = 12;
export const NOTE_MIN = 10;
export const NOTE_MAX = 1000;

export const SEVERITIES = ['s1', 's2', 's3', 's4'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const STATE_FILTERS = ['live', 'open', 'acknowledged', 'resolved', 'all'] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];
export type AlertState = 'open' | 'acknowledged' | 'resolved';
export type KeyType = 'account' | 'ip' | 'market' | 'event';
export const RESOLUTIONS = ['contained', 'false-positive', 'duplicate', 'accepted-risk'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export type Channel = 'email' | 'sms' | 'call' | 'team-chat';
export type DeliveryOutcome = 'sent' | 'failed' | 'not-configured' | 'no-contact';

export interface AlertSummary {
  readonly id: string;
  readonly rule: string;
  readonly title: string;
  readonly severity: Severity;
  readonly state: AlertState;
  readonly keyType: KeyType;
  readonly keyLabel: string;
  readonly eventCount: number;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly openedAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedByName: string | null;
  readonly resolvedAt: string | null;
  readonly nextNotifyAt: string | null;
  readonly version: number;
}

export interface AlertPage {
  readonly alerts: readonly AlertSummary[];
  readonly next: string | null;
}

export interface AlertDelivery {
  readonly step: number;
  readonly recipient: string;
  readonly channel: Channel;
  readonly outcome: DeliveryOutcome;
  readonly at: string;
}

export interface AlertDetail extends AlertSummary {
  readonly keyValue: string;
  readonly notifyStep: number;
  readonly acknowledgedBy: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedByName: string | null;
  readonly viewerResolvesCritical: boolean;
  readonly resolution: Resolution | null;
  readonly resolutionNote: string | null;
  readonly deliveries: readonly AlertDelivery[];
}

export interface Person {
  readonly code: string;
  readonly name: string;
}

export interface Summary {
  readonly live: Readonly<Record<Severity, number>>;
  readonly rulesLastRanAt: string | null;
  readonly onCall: Person | null;
}

export interface OnCall {
  readonly configured: boolean;
  readonly zone: string | null;
  readonly businessHours: {
    readonly start: string;
    readonly end: string;
    readonly days: readonly number[];
  } | null;
  readonly inBusinessHours: boolean | null;
  readonly onCall: Person | null;
  readonly escalation: readonly Person[];
  readonly escalationIntervalMinutes: number;
  readonly escalationMaxSteps: number;
  readonly rotation: readonly (Person & { readonly startsAt: string })[];
  readonly incidentCommander: Person | null;
  readonly securityOwner: Person | null;
  readonly channels: Readonly<Record<Severity, readonly Channel[]>>;
}

/** The API's state filter for a page filter. */
export function stateQuery(filter: StateFilter): string {
  if (filter === 'live') return 'open,acknowledged';
  if (filter === 'all') return '';
  return filter;
}

/** Whether the rules have not finished a run for a while (or never). */
export function rulesStale(lastRanAt: string | null, now: number): boolean {
  return lastRanAt === null || now - Date.parse(lastRanAt) > RULES_STALE_MS;
}

/** Whole minutes between two instants, never negative. */
export function minutesBetween(fromIso: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60_000));
}

/** The note as the API counts it: trimmed, by code point. */
export function noteLength(note: string): number {
  return Array.from(note.trim()).length;
}
