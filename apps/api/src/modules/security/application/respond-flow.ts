import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import { clientAddressOf, expandIPv6 } from '../../../platform/rate-limit/client-origin';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  acknowledgeAlert,
  ALERT_RESOLUTIONS,
  ALERT_STATES,
  normaliseNote,
  resolveAlert,
  type AlertResolution,
  type AlertState,
  type SecurityAlert,
} from '../domain/alert';
import { AlertAcknowledged, AlertResolved } from '../domain/audit';
import {
  CHANNELS_BY_SEVERITY,
  S1_ESCALATION_INTERVAL,
  S1_MAX_STEPS,
  type DeliveryChannel,
} from '../domain/delivery';
import { findRule } from '../domain/rules';
import {
  escalationChain,
  isBusinessTime,
  memberOf,
  onCallAt,
  weekStartAt,
  type OnCallRoster,
} from '../domain/roster';
import { isSeverity, SEVERITIES, type SecuritySeverity } from '../domain/severity';
import type { AlertDeliveryRecord } from './ports/security-alert.repository';
import type { SecurityDependencies } from './security-dependencies';

// The security centre's reads and the responders' acts (package 2; design section 2, D2). Every
// act is refused in an acting-as session, checks the version the responder saw, is audited and
// returns the alert as stored.

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
}

export type SecurityFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'security.alert-not-found' }
  /** Another responder changed the alert first; the page reloads it. */
  | { readonly code: 'security.conflict' }
  /** The alert is not in a state the act starts from (already acknowledged or resolved). */
  | { readonly code: 'security.alert-state' }
  /** Only the incident commander or the security owner resolves an s1 alert (D2). */
  | { readonly code: 'security.s1-resolver-only' };

const isActingAs = (context: CallContext): boolean => {
  const actor = context.actor;
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
};

/** An admin session that is not acting as someone else. */
function adminAccountId(context: CallContext): string | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return null;
  return isActingAs(context) ? null : actor.accountId;
}

// ------------------------------------------------------------------------------------------------
// Views

/** An alert as the list shows it: the address of an `ip` key is masked (the detail shows it). */
export interface AlertSummaryView {
  readonly id: string;
  readonly rule: string;
  readonly title: string;
  readonly severity: SecuritySeverity;
  readonly state: AlertState;
  readonly keyType: SecurityAlert['keyType'];
  readonly keyLabel: string;
  readonly eventCount: number;
  readonly firstEventAt: Temporal.Instant;
  readonly lastEventAt: Temporal.Instant;
  readonly openedAt: Temporal.Instant;
  readonly acknowledgedAt: Temporal.Instant | null;
  readonly resolvedAt: Temporal.Instant | null;
  readonly nextNotifyAt: Temporal.Instant | null;
  readonly version: number;
}

export interface AlertDetailView extends AlertSummaryView {
  /** The key in full: an account id, an address, the Market code or an event id. */
  readonly keyValue: string;
  readonly notifyStep: number;
  readonly acknowledgedBy: string | null;
  readonly resolvedBy: string | null;
  readonly resolution: AlertResolution | null;
  readonly resolutionNote: string | null;
  readonly deliveries: readonly AlertDeliveryRecord[];
}

/**
 * An address key, masked: IPv4 (also IPv4-mapped IPv6) keeps its first three octets, IPv6 its
 * first three groups (48 bits), read from the expanded form so a compressed address never shows
 * its host part.
 */
export function maskAddress(value: string): string {
  const address = clientAddressOf(value);
  if (address === null) return '…';
  if (address.includes(':')) {
    const groups = expandIPv6(address);
    return groups === null
      ? '…'
      : `${groups
          .slice(0, 3)
          .map((g) => g.toString(16))
          .join(':')}:…`;
  }
  return `${address.split('.').slice(0, 3).join('.')}.…`;
}

function summaryOf(alert: SecurityAlert): AlertSummaryView {
  return {
    id: alert.id,
    rule: alert.rule,
    title: findRule(alert.rule)?.title ?? alert.rule,
    severity: alert.severity,
    state: alert.state,
    keyType: alert.keyType,
    keyLabel: alert.keyType === 'ip' ? maskAddress(alert.keyValue) : alert.keyValue,
    eventCount: alert.eventCount,
    firstEventAt: alert.firstEventAt,
    lastEventAt: alert.lastEventAt,
    openedAt: alert.openedAt,
    acknowledgedAt: alert.acknowledgedAt,
    resolvedAt: alert.resolvedAt,
    nextNotifyAt: alert.nextNotifyAt,
    version: alert.version,
  };
}

export const MAX_ALERT_PAGE = 100;
export const DEFAULT_ALERT_PAGE = 50;

export interface AlertPage {
  readonly alerts: readonly AlertSummaryView[];
  /** The cursor of the next page, or null on the last. */
  readonly next: string | null;
}

/** The cursor of a page: the last row's severity, opened instant and id, base64url JSON. */
function encodeCursor(alert: SecurityAlert): string {
  return Buffer.from(
    JSON.stringify([alert.severity, alert.openedAt.epochMilliseconds, alert.id]),
  ).toString('base64url');
}

function decodeCursor(
  value: string,
): { severity: SecuritySeverity; openedAt: Temporal.Instant; id: string } | null {
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [severity, millis, id] = parsed as unknown[];
    if (!isSeverity(severity) || !Number.isSafeInteger(millis) || typeof id !== 'string')
      return null;
    if (!parseId(id).ok) return null;
    return { severity, openedAt: Temporal.Instant.fromEpochMilliseconds(millis as number), id };
  } catch {
    return null;
  }
}

/** A comma-separated filter of known codes; empty or absent means every code. */
function codesOf<T extends string>(
  value: unknown,
  known: readonly T[],
  path: string,
  fields: FieldIssue[],
): readonly T[] {
  if (value === undefined || value === '') return known;
  if (typeof value !== 'string' || value.length > 100) {
    fields.push({ path, code: 'type' });
    return known;
  }
  const codes = [...new Set(value.split(','))];
  if (!codes.every((code) => (known as readonly string[]).includes(code))) {
    fields.push({ path, code: 'value' });
    return known;
  }
  return codes as T[];
}

export async function listAlerts(
  deps: SecurityDependencies,
  context: CallContext,
  input: {
    readonly state?: unknown;
    readonly severity?: unknown;
    readonly after?: unknown;
    readonly limit?: unknown;
  },
): Promise<Result<AlertPage, SecurityFailure>> {
  const fields: FieldIssue[] = [];
  const states = codesOf(input.state, ALERT_STATES, 'state', fields);
  const severities = codesOf(input.severity, SEVERITIES, 'severity', fields);
  let after: ReturnType<typeof decodeCursor> = null;
  if (input.after !== undefined) {
    after = typeof input.after === 'string' ? decodeCursor(input.after) : null;
    if (after === null) fields.push({ path: 'after', code: 'value' });
  }
  let limit = DEFAULT_ALERT_PAGE;
  if (input.limit !== undefined) {
    const parsed = typeof input.limit === 'string' ? Number(input.limit) : input.limit;
    if (
      !Number.isSafeInteger(parsed) ||
      (parsed as number) < 1 ||
      (parsed as number) > MAX_ALERT_PAGE
    ) {
      fields.push({ path: 'limit', code: 'value' });
    } else {
      limit = parsed as number;
    }
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return deps.unitOfWork.run<AlertPage, SecurityFailure>(
    context.market,
    async () => {
      const rows = await deps.alerts.list(context.market, {
        states,
        severities,
        after,
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      return ok({
        alerts: page.map(summaryOf),
        next: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
      });
    },
    { readOnly: true },
  );
}

function alertIdOf(value: unknown): string | null {
  return typeof value === 'string' && parseId(value).ok ? value : null;
}

export async function viewAlert(
  deps: SecurityDependencies,
  context: CallContext,
  input: { readonly alertId?: unknown },
): Promise<Result<AlertDetailView, SecurityFailure>> {
  const alertId = alertIdOf(input.alertId);
  if (alertId === null) return err({ code: 'security.alert-not-found' });
  return deps.unitOfWork.run<AlertDetailView, SecurityFailure>(
    context.market,
    async () => {
      const alert = await deps.alerts.get(context.market, alertId);
      if (alert === null) return err({ code: 'security.alert-not-found' });
      return ok(await detailOf(deps, context, alert));
    },
    { readOnly: true },
  );
}

async function detailOf(
  deps: SecurityDependencies,
  context: CallContext,
  alert: SecurityAlert,
): Promise<AlertDetailView> {
  return {
    ...summaryOf(alert),
    keyValue: alert.keyValue,
    notifyStep: alert.notifyStep,
    acknowledgedBy: alert.acknowledgedBy,
    resolvedBy: alert.resolvedBy,
    resolution: alert.resolution,
    resolutionNote: alert.resolutionNote,
    deliveries: await deps.alerts.deliveriesOf(context.market, alert.id),
  };
}

export interface SummaryView {
  /** Open or acknowledged alerts by severity. */
  readonly live: Readonly<Record<SecuritySeverity, number>>;
  /** When the rules last finished a run for the Market, or null before the first. */
  readonly rulesLastRanAt: Temporal.Instant | null;
  /** Who is on call now (code and name), or null without a roster. */
  readonly onCall: { readonly code: string; readonly name: string } | null;
}

export async function viewSummary(
  deps: SecurityDependencies,
  context: CallContext,
): Promise<Result<SummaryView, SecurityFailure>> {
  const roster = deps.roster.roster();
  const now = deps.clock.now();
  return deps.unitOfWork.run<SummaryView, SecurityFailure>(
    context.market,
    async () => {
      const live = await deps.alerts.liveCounts(context.market);
      const run = await deps.alerts.lastEvaluatorRun(context.market);
      return ok({
        live,
        rulesLastRanAt: run?.finishedAt ?? null,
        onCall: roster === null ? null : personOf(roster, onCallAt(roster, now)),
      });
    },
    { readOnly: true },
  );
}

const personOf = (roster: OnCallRoster, code: string) => ({
  code,
  name: memberOf(roster, code)?.name ?? code,
});

export interface OnCallView {
  readonly configured: boolean;
  readonly zone: string | null;
  readonly businessHours: {
    readonly start: string;
    readonly end: string;
    readonly days: readonly number[];
  } | null;
  readonly inBusinessHours: boolean | null;
  readonly onCall: { readonly code: string; readonly name: string } | null;
  /** s1: who is alerted at each step, in order. */
  readonly escalation: readonly { readonly code: string; readonly name: string }[];
  readonly escalationIntervalMinutes: number;
  readonly escalationMaxSteps: number;
  /** This week and the next three. */
  readonly rotation: readonly {
    readonly startsAt: Temporal.Instant;
    readonly code: string;
    readonly name: string;
  }[];
  readonly incidentCommander: { readonly code: string; readonly name: string } | null;
  readonly securityOwner: { readonly code: string; readonly name: string } | null;
  readonly channels: Readonly<Record<SecuritySeverity, readonly DeliveryChannel[]>>;
}

const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** The on-call tab: names and codes only, never an address or a number. */
export function viewOnCall(deps: SecurityDependencies): Result<OnCallView, SecurityFailure> {
  const roster = deps.roster.roster();
  const base = {
    escalationIntervalMinutes: S1_ESCALATION_INTERVAL.total({ unit: 'minutes' }),
    escalationMaxSteps: S1_MAX_STEPS,
    channels: CHANNELS_BY_SEVERITY,
  };
  if (roster === null) {
    return ok({
      ...base,
      configured: false,
      zone: null,
      businessHours: null,
      inBusinessHours: null,
      onCall: null,
      escalation: [],
      rotation: [],
      incidentCommander: null,
      securityOwner: null,
    });
  }
  const now = deps.clock.now();
  return ok({
    ...base,
    configured: true,
    zone: roster.hours.zone,
    businessHours: {
      start: hhmm(roster.hours.startMinute),
      end: hhmm(roster.hours.endMinute),
      days: roster.hours.days,
    },
    inBusinessHours: isBusinessTime(roster.hours, now),
    onCall: personOf(roster, onCallAt(roster, now)),
    escalation: escalationChain(roster, now).map((code) => personOf(roster, code)),
    rotation: [0, 1, 2, 3].map((offset) => ({
      startsAt: weekStartAt(roster, now, offset),
      ...personOf(roster, onCallAt(roster, now, offset)),
    })),
    incidentCommander: personOf(roster, roster.incidentCommander),
    securityOwner: personOf(roster, roster.securityOwner),
  });
}

// ------------------------------------------------------------------------------------------------
// Acts

function versionIssue(value: unknown, fields: FieldIssue[]): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fields.push({ path: 'expectedVersion', code: 'type' });
    return 0;
  }
  return value as number;
}

export async function acknowledge(
  deps: SecurityDependencies,
  context: CallContext,
  input: { readonly alertId?: unknown; readonly expectedVersion?: unknown },
): Promise<Result<AlertDetailView, SecurityFailure>> {
  const by = adminAccountId(context);
  if (by === null) return err({ code: 'access.denied' });
  const alertId = alertIdOf(input.alertId);
  if (alertId === null) return err({ code: 'security.alert-not-found' });
  const fields: FieldIssue[] = [];
  const expected = versionIssue(input.expectedVersion, fields);
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  const now = deps.clock.now();
  return deps.unitOfWork.run<AlertDetailView, SecurityFailure>(context.market, async () => {
    const alert = await deps.alerts.get(context.market, alertId);
    if (alert === null) return err({ code: 'security.alert-not-found' });
    if (alert.version !== expected) return err({ code: 'security.conflict' });
    const next = acknowledgeAlert(alert, by, now);
    if (typeof next === 'string') return err({ code: next });
    if (!(await deps.alerts.saveTransition(context.market, next))) {
      return err({ code: 'security.conflict' });
    }
    await deps.audit.record(
      context,
      AlertAcknowledged.entry(next.id as never, {
        after: { severity: next.severity, version: next.version },
      }),
    );
    return ok(await detailOf(deps, context, next));
  });
}

export async function resolve(
  deps: SecurityDependencies,
  context: CallContext,
  input: {
    readonly alertId?: unknown;
    readonly expectedVersion?: unknown;
    readonly resolution?: unknown;
    readonly note?: unknown;
  },
): Promise<Result<AlertDetailView, SecurityFailure>> {
  const by = adminAccountId(context);
  if (by === null) return err({ code: 'access.denied' });
  const alertId = alertIdOf(input.alertId);
  if (alertId === null) return err({ code: 'security.alert-not-found' });
  const fields: FieldIssue[] = [];
  const expected = versionIssue(input.expectedVersion, fields);
  const resolution = (ALERT_RESOLUTIONS as readonly unknown[]).includes(input.resolution)
    ? (input.resolution as AlertResolution)
    : null;
  if (resolution === null) fields.push({ path: 'resolution', code: 'value' });
  const note = normaliseNote(input.note);
  if (note === null) fields.push({ path: 'note', code: 'length' });
  if (fields.length > 0 || resolution === null || note === null) {
    return err({ code: 'validation.failed', fields });
  }
  const roster = deps.roster.roster();
  const s1Resolvers =
    roster === null
      ? []
      : [roster.incidentCommander, roster.securityOwner].flatMap(
          (code) => memberOf(roster, code)?.accountId ?? [],
        );
  const now = deps.clock.now();
  return deps.unitOfWork.run<AlertDetailView, SecurityFailure>(context.market, async () => {
    const alert = await deps.alerts.get(context.market, alertId);
    if (alert === null) return err({ code: 'security.alert-not-found' });
    if (alert.version !== expected) return err({ code: 'security.conflict' });
    const next = resolveAlert(alert, { by, at: now, resolution, note, s1Resolvers });
    if (typeof next === 'string') return err({ code: next });
    if (!(await deps.alerts.saveTransition(context.market, next))) {
      return err({ code: 'security.conflict' });
    }
    await deps.audit.record(
      context,
      AlertResolved.entry(next.id as never, {
        after: { severity: next.severity, resolution, version: next.version },
      }),
    );
    return ok(await detailOf(deps, context, next));
  });
}
