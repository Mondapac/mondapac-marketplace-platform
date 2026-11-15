import { Temporal } from '@mondapac/shared-kernel';
import type { SecuritySeverity } from './severity';

// The rule catalogue of the SOC (package 2; plan sections 2 and 4, decision T4). Rules are code
// configuration: a threshold or a window changes in a reviewed PR, like the event catalogue they
// read (security-tester reads every change; snapshot in
// apps/api/test/contracts/security-rule-catalogue.snapshot.json). Every type a rule names is in
// the closed security event catalogue (checked by security-rules.spec.ts).

/** What a rule groups its events by: an alert is opened per key. */
export type AlertKeyType = 'account' | 'ip' | 'market' | 'event';

export const ALERT_KEY_TYPES: readonly AlertKeyType[] = ['account', 'ip', 'market', 'event'];

interface RuleBase {
  /** kebab-case, at most 64 characters: the alert's `rule` column. */
  readonly code: string;
  readonly severity: SecuritySeverity;
  /** One line in English for the alert list, the email subject and the page (admin is English). */
  readonly title: string;
}

/**
 * At least `threshold` events of `types` in `window`, per key. With key `market` every event of
 * the Market counts towards one key.
 */
export interface ThresholdRule extends RuleBase {
  readonly kind: 'threshold';
  readonly types: readonly string[];
  readonly payloadEquals?: Readonly<Record<string, string>>;
  readonly groupBy: 'account' | 'ip' | 'market';
  readonly threshold: number;
  readonly window: Temporal.Duration;
}

/** Every event of `types` opens its own alert (key `event`). `lookback` bounds the scan. */
export interface EachEventRule extends RuleBase {
  readonly kind: 'each';
  readonly types: readonly string[];
  readonly payloadEquals?: Readonly<Record<string, string>>;
  readonly lookback: Temporal.Duration;
}

/**
 * An event of `success` (key `event`) whose target had at least `threshold` events of `failures`
 * in the `window` before it: a session opened after a run of refused attempts.
 */
export interface SuccessAfterFailuresRule extends RuleBase {
  readonly kind: 'success-after-failures';
  readonly success: {
    readonly type: string;
    readonly payloadEquals?: Readonly<Record<string, string>>;
  };
  readonly failures: {
    readonly types: readonly string[];
    readonly payloadEquals?: Readonly<Record<string, string>>;
  };
  readonly threshold: number;
  readonly window: Temporal.Duration;
  readonly lookback: Temporal.Duration;
}

export type SecurityRule = ThresholdRule | EachEventRule | SuccessAfterFailuresRule;

/** The key type of the alerts a rule opens. */
export function keyTypeOf(rule: SecurityRule): AlertKeyType {
  return rule.kind === 'threshold' ? rule.groupBy : 'event';
}

/**
 * How far back a rule reads. The evaluator runs every minute; a run that is late by more than this
 * misses the events that fell out of the window (docs/design/data/security.md 4.1).
 */
export function horizonOf(rule: SecurityRule): Temporal.Duration {
  return rule.kind === 'threshold' ? rule.window : rule.lookback;
}

const minutes = (value: number) => Temporal.Duration.from({ minutes: value });
const hours = (value: number) => Temporal.Duration.from({ hours: value });

const admin = { population: 'admin' } as const;

/** The rules, in evaluation order. */
export const SECURITY_RULES: readonly SecurityRule[] = Object.freeze([
  // S1: plan section 4 row 1.
  {
    code: 'admin-sign-in-after-failures',
    kind: 'success-after-failures',
    severity: 's1',
    title: 'Admin signed in after repeated failed attempts',
    success: { type: 'identity.sign-in.succeeded', payloadEquals: admin },
    failures: { types: ['identity.sign-in.failed'], payloadEquals: admin },
    threshold: 3,
    window: minutes(30),
    lookback: minutes(30),
  },
  {
    code: 'payout-account-changes-burst',
    kind: 'threshold',
    severity: 's1',
    title: 'Several seller payout accounts changed within an hour',
    types: ['payments.payout-change.recorded'],
    groupBy: 'market',
    threshold: 3,
    window: hours(1),
  },
  // S2: plan section 4 row 2 (handoff: 10 failed sign-ins in 5 minutes per account or address).
  {
    code: 'sign-in-failures-account',
    kind: 'threshold',
    severity: 's2',
    title: 'Many failed sign-ins on one account',
    types: ['identity.sign-in.failed'],
    groupBy: 'account',
    threshold: 10,
    window: minutes(5),
  },
  {
    code: 'sign-in-failures-ip',
    kind: 'threshold',
    severity: 's2',
    title: 'Many failed sign-ins from one address',
    types: ['identity.sign-in.failed'],
    groupBy: 'ip',
    threshold: 10,
    window: minutes(5),
  },
  {
    code: 'admin-second-factor-failures',
    kind: 'threshold',
    severity: 's2',
    title: 'Repeated wrong admin second-factor codes',
    types: ['identity.second-factor.failed'],
    payloadEquals: admin,
    groupBy: 'account',
    threshold: 5,
    window: minutes(10),
  },
  {
    code: 'second-factor-locked',
    kind: 'each',
    severity: 's2',
    title: 'A second factor was locked after too many wrong codes',
    types: ['identity.second-factor.locked'],
    lookback: hours(1),
  },
  {
    code: 'admin-role-changes-burst',
    kind: 'threshold',
    severity: 's2',
    title: 'Many admin role assignments within an hour',
    types: ['identity.account-role.assigned', 'identity.account-role.changed'],
    groupBy: 'market',
    threshold: 5,
    window: hours(1),
  },
  {
    code: 'money-movement-alert',
    kind: 'each',
    severity: 's2',
    title: 'A payment, payout or dispute needs a person',
    types: [
      'payments.transfer.alert',
      'payments.dispute.unmatched',
      'commission-payouts.payout.alert',
      'commission-payouts.dispute.order-mismatch',
    ],
    lookback: hours(1),
  },
  {
    code: 'retired-category-relaxing-policy',
    kind: 'each',
    severity: 's2',
    title: 'A relaxing certification policy was found on a retired category',
    types: ['certification.retired-category.flagged-relaxing'],
    lookback: hours(1),
  },
  // S3: plan section 4 row 3.
  {
    code: 'webhook-signature-failures',
    kind: 'threshold',
    severity: 's3',
    title: 'Webhooks with bad signatures from one address',
    types: ['payments.webhook-signature.failed', 'shipping.webhook-signature.failed'],
    groupBy: 'ip',
    threshold: 5,
    window: minutes(10),
  },
  {
    code: 'sign-in-throttled-burst',
    kind: 'threshold',
    severity: 's3',
    title: 'Many sign-in attempts hit the rate limit',
    types: ['identity.sign-in.throttled'],
    groupBy: 'market',
    threshold: 20,
    window: hours(1),
  },
  {
    code: 'payout-live-check-failures',
    kind: 'threshold',
    severity: 's3',
    title: 'The live check before payouts keeps failing',
    types: ['payments.live-check.failed'],
    groupBy: 'market',
    threshold: 3,
    window: hours(1),
  },
  // S4: plan section 4 row 4 (scattered failures, weekly report).
  {
    code: 'sign-in-failures-daily',
    kind: 'threshold',
    severity: 's4',
    title: 'Failed sign-ins across the Market in a day',
    types: ['identity.sign-in.failed'],
    groupBy: 'market',
    threshold: 50,
    window: hours(24),
  },
] satisfies readonly SecurityRule[]);

/** The rule with this code, or null. */
export function findRule(code: string): SecurityRule | null {
  return SECURITY_RULES.find((rule) => rule.code === code) ?? null;
}
