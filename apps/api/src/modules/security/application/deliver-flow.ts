import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import type { SecurityAlert } from '../domain/alert';
import {
  CHANNELS_BY_SEVERITY,
  planDelivery,
  S1_MAX_STEPS,
  type DeliveryOutcome,
  type DeliveryStep,
} from '../domain/delivery';
import { findRule } from '../domain/rules';
import {
  isBusinessTime,
  localDate,
  localIsoWeek,
  memberOf,
  type OnCallRoster,
} from '../domain/roster';
import type { SecuritySeverity } from '../domain/severity';
import type { AlertMessage } from './ports/alert-messenger';
import type { AlertDeliveryRecord } from './ports/security-alert.repository';
import type { SecurityDependencies } from './security-dependencies';

// The delivery job (decisions T3, T4; docs/design/data/security.md 4.2). Every minute, per Market,
// it takes the due step of each open alert: it claims the step first (a conditional update on the
// alert's version), then sends, then records each message's outcome on the alert's timeline. A
// process that stops between the claim and the record loses that step's messages, never sends
// them twice; an s1 alert's next step follows 10 minutes later all the same. And the digest job:
// a daily digest of s3 alerts and a weekly report of s4 alerts to the security owner, in business
// hours, once per period.

const logger = new Logger('SecurityAlertDelivery');

/** Alerts one delivery run takes (bounded work, P 7). */
export const DELIVERY_BATCH = 50;

/** The recipient code recorded when no roster is configured. */
export const NO_ROSTER_RECIPIENT = 'roster';

const SEVERITY_LABEL: Readonly<Record<SecuritySeverity, string>> = {
  s1: 'S1 (critical)',
  s2: 'S2 (high)',
  s3: 'S3 (medium)',
  s4: 'S4 (low)',
};

/** The message of one alert step: rule, counts, instants and the alert id; nothing personal. */
export function alertMessage(alert: SecurityAlert, step: number): AlertMessage {
  const title = findRule(alert.rule)?.title ?? alert.rule;
  const lines = [
    `Severity: ${SEVERITY_LABEL[alert.severity]}`,
    `Rule: ${alert.rule} - ${title}`,
    `Events: ${alert.eventCount}, from ${alert.firstEventAt.toString()} to ${alert.lastEventAt.toString()}`,
    `Alert: ${alert.id}`,
  ];
  if (alert.severity === 's1') {
    lines.push(
      `Escalation step ${step} of ${S1_MAX_STEPS}. Until someone acknowledges it, the next person ` +
        'on the escalation list is alerted every 10 minutes.',
    );
  }
  lines.push('Open the Security centre in the admin panel to acknowledge or resolve it.');
  return {
    subject: `[${alert.severity.toUpperCase()}] Security alert: ${title}`,
    text: lines.join('\n'),
  };
}

async function sendStep(
  deps: SecurityDependencies,
  market: MarketContext,
  roster: OnCallRoster | null,
  alert: SecurityAlert,
  plan: DeliveryStep,
  now: Temporal.Instant,
): Promise<readonly AlertDeliveryRecord[]> {
  const record = (
    recipient: string,
    channel: AlertDeliveryRecord['channel'],
    outcome: DeliveryOutcome,
  ) => ({
    id: deps.ids.next<'SecurityAlertDelivery'>(),
    alertId: alert.id,
    step: plan.nextStep,
    recipient,
    channel,
    outcome,
    at: now,
  });
  if (roster === null) {
    return CHANNELS_BY_SEVERITY[alert.severity].map((channel) =>
      record(NO_ROSTER_RECIPIENT, channel, 'not-configured'),
    );
  }
  const message = alertMessage(alert, plan.nextStep);
  const rows: AlertDeliveryRecord[] = [];
  for (const { recipient, channel } of plan.messages) {
    const member = memberOf(roster, recipient);
    const outcome =
      member === null ? 'no-contact' : await deps.messenger.send(market, member, channel, message);
    rows.push(record(recipient, channel, outcome));
  }
  return rows;
}

export interface DeliveryReport {
  readonly steps: number;
  readonly messages: number;
  readonly failed: number;
}

/** One delivery run for the context's Market (rule `system`). */
export async function deliverDueAlerts(
  deps: SecurityDependencies,
  context: CallContext,
): Promise<Result<DeliveryReport, never>> {
  const market = context.market;
  const now = deps.clock.now();
  const roster = deps.roster.roster();
  const due = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.alerts.due(market, now, DELIVERY_BATCH)),
    { readOnly: true },
  );
  if (!due.ok) return ok({ steps: 0, messages: 0, failed: 0 });
  let steps = 0;
  let messages = 0;
  let failed = 0;
  for (const alert of due.value) {
    const plan: DeliveryStep =
      roster === null
        ? { messages: [], nextStep: alert.notifyStep + 1, nextNotifyAt: null }
        : planDelivery(alert.severity, alert.notifyStep, roster, now);
    const claimed = await deps.unitOfWork.run(market, async () =>
      ok(
        await deps.alerts.claimStep(market, alert, {
          notifyStep: plan.nextStep,
          nextNotifyAt: plan.nextNotifyAt,
        }),
      ),
    );
    if (!claimed.ok || !claimed.value) continue;
    // A step that only waits for business hours, or the end of an exhausted escalation, sends nothing.
    if (plan.nextStep === alert.notifyStep) {
      if (plan.nextNotifyAt === null) {
        // Operators alert on this: an s1 alert nobody acknowledged in two hours of escalation.
        logger.warn({
          msg: 'security.escalation-exhausted',
          alertId: alert.id,
          rule: alert.rule,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
      continue;
    }
    const rows = await sendStep(deps, market, roster, alert, plan, now);
    await deps.unitOfWork.run(market, async () => {
      await deps.alerts.recordDeliveries(market, rows);
      return ok(undefined);
    });
    steps += 1;
    messages += rows.length;
    failed += rows.filter((row) => row.outcome !== 'sent').length;
    if (roster === null) {
      // Operators alert on this: alerts are being opened with nobody to tell.
      logger.warn({
        msg: 'security.roster-not-configured',
        alertId: alert.id,
        severity: alert.severity,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
  }
  return ok({ steps, messages, failed });
}

const DIGESTS = [
  { kind: 'daily', severity: 's3', window: Temporal.Duration.from({ hours: 24 }) },
  { kind: 'weekly', severity: 's4', window: Temporal.Duration.from({ hours: 7 * 24 }) },
] as const;

export interface DigestReport {
  readonly sent: number;
}

/**
 * The digests for the context's Market (rule `system`), run hourly: in business hours, a daily
 * digest of s3 alerts opened in the last 24 hours and a weekly report of s4 alerts opened in the
 * last 7 days, each to the security owner once per period (its local date or ISO week). A period
 * with no such alert and none live sends nothing yet.
 */
export async function sendDigests(
  deps: SecurityDependencies,
  context: CallContext,
): Promise<Result<DigestReport, never>> {
  const roster = deps.roster.roster();
  const now = deps.clock.now();
  if (roster === null || !isBusinessTime(roster.hours, now)) return ok({ sent: 0 });
  const market = context.market;
  const owner = memberOf(roster, roster.securityOwner);
  let sent = 0;
  for (const digest of DIGESTS) {
    const period =
      digest.kind === 'daily' ? localDate(roster.hours, now) : localIsoWeek(roster.hours, now);
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        if (await deps.alerts.hasDigest(market, digest.kind, period)) return ok(null);
        return ok(
          // The window ends just after now, so an alert opened this instant is counted.
          await deps.alerts.countOpened(
            market,
            digest.severity,
            now.subtract(digest.window),
            now.add({ milliseconds: 1 }),
          ),
        );
      },
      { readOnly: true },
    );
    if (!read.ok || read.value === null) continue;
    const { opened, live } = read.value;
    if (opened === 0 && live === 0) continue;
    const label = digest.kind === 'daily' ? 'Daily security digest' : 'Weekly security report';
    const message: AlertMessage = {
      subject: `${label}: ${opened} new ${digest.severity.toUpperCase()} alerts`,
      text: [
        `${label} for ${period} (${market.marketId}).`,
        `${SEVERITY_LABEL[digest.severity]} alerts opened in the period: ${opened}`,
        `Still open or acknowledged: ${live}`,
        'Open the Security centre in the admin panel to review them.',
      ].join('\n'),
    };
    const outcome: DeliveryOutcome =
      owner === null ? 'no-contact' : await deps.messenger.send(market, owner, 'email', message);
    await deps.unitOfWork.run(market, async () => {
      await deps.alerts.recordDigest(market, {
        kind: digest.kind,
        period,
        alerts: opened,
        outcome,
        sentAt: now,
      });
      return ok(undefined);
    });
    if (outcome === 'sent') sent += 1;
  }
  return ok({ sent });
}
