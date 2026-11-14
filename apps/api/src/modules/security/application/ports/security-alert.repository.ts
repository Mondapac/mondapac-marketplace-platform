import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AlertState, SecurityAlert } from '../../domain/alert';
import type { DeliveryChannel, DeliveryOutcome } from '../../domain/delivery';
import type { AlertKeyType } from '../../domain/rules';
import type { SecuritySeverity } from '../../domain/severity';

/** A new alert, as the evaluator opens it. */
export interface NewAlert {
  readonly id: string;
  readonly rule: string;
  readonly severity: SecuritySeverity;
  readonly keyType: AlertKeyType;
  readonly keyValue: string;
  readonly eventCount: number;
  readonly firstEventAt: Temporal.Instant;
  readonly lastEventAt: Temporal.Instant;
  readonly openedAt: Temporal.Instant;
  readonly nextNotifyAt: Temporal.Instant | null;
}

/** One row of an alert's timeline. */
export interface AlertDeliveryRecord {
  readonly id: string;
  readonly alertId: string;
  readonly step: number;
  readonly recipient: string;
  readonly channel: DeliveryChannel;
  readonly outcome: DeliveryOutcome;
  readonly at: Temporal.Instant;
}

export interface AlertListQuery {
  readonly states: readonly AlertState[];
  readonly severities: readonly SecuritySeverity[];
  /** The last row of the previous page (severity, opened at, id), or null for the first page. */
  readonly after: {
    readonly severity: SecuritySeverity;
    readonly openedAt: Temporal.Instant;
    readonly id: string;
  } | null;
  readonly limit: number;
}

export interface DigestRunRecord {
  readonly kind: 'daily' | 'weekly';
  readonly period: string;
  readonly alerts: number;
  readonly outcome: DeliveryOutcome;
  readonly sentAt: Temporal.Instant;
}

/**
 * The alerts of one Market in `security.alerts` and their timeline. Every method runs in the
 * caller's open unit and is scoped by the Market.
 */
export interface SecurityAlertRepository {
  /** The open or acknowledged alert of a rule and key, if any. */
  findLive(
    market: MarketContext,
    rule: string,
    keyType: AlertKeyType,
    keyValue: string,
  ): Promise<SecurityAlert | null>;

  /** When the last resolved alert of a rule and key was resolved, if any. */
  lastResolvedAt(
    market: MarketContext,
    rule: string,
    keyType: AlertKeyType,
    keyValue: string,
  ): Promise<Temporal.Instant | null>;

  /** Inserts an open alert; false when a live alert of the rule and key exists (a racing run). */
  open(market: MarketContext, alert: NewAlert): Promise<boolean>;

  /**
   * Raises a live alert's count and last event to the new match when they grew; answers whether
   * it changed. Never touches its state or delivery.
   */
  touch(
    market: MarketContext,
    alert: SecurityAlert,
    match: { readonly eventCount: number; readonly lastEventAt: Temporal.Instant },
  ): Promise<boolean>;

  /** Writes a transition (acknowledge, resolve) if the stored version is still `alert.version - 1`. */
  saveTransition(market: MarketContext, alert: SecurityAlert): Promise<boolean>;

  /**
   * Claims a delivery step: sets the step and the next due instant if the alert is still open at
   * `fromStep` with `nextNotifyAt` due. Answers false when another run took it or it was
   * acknowledged meanwhile.
   */
  claimStep(
    market: MarketContext,
    alert: SecurityAlert,
    next: { readonly notifyStep: number; readonly nextNotifyAt: Temporal.Instant | null },
  ): Promise<boolean>;

  /** Open alerts whose next step is due at `now`, oldest due first. */
  due(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly SecurityAlert[]>;

  get(market: MarketContext, id: string): Promise<SecurityAlert | null>;

  list(market: MarketContext, query: AlertListQuery): Promise<readonly SecurityAlert[]>;

  /** How many open or acknowledged alerts of each severity. */
  liveCounts(market: MarketContext): Promise<Readonly<Record<SecuritySeverity, number>>>;

  /** How many alerts of a severity opened in [since, until), and how many of them are live. */
  countOpened(
    market: MarketContext,
    severity: SecuritySeverity,
    since: Temporal.Instant,
    until: Temporal.Instant,
  ): Promise<{ readonly opened: number; readonly live: number }>;

  recordDeliveries(market: MarketContext, rows: readonly AlertDeliveryRecord[]): Promise<void>;

  deliveriesOf(market: MarketContext, alertId: string): Promise<readonly AlertDeliveryRecord[]>;

  /** Records a digest run; false when the period's digest is already recorded. */
  recordDigest(market: MarketContext, run: DigestRunRecord): Promise<boolean>;

  hasDigest(market: MarketContext, kind: 'daily' | 'weekly', period: string): Promise<boolean>;

  /** Stores the end of an evaluator run (one row per Market). */
  recordEvaluatorRun(
    market: MarketContext,
    run: { readonly finishedAt: Temporal.Instant; readonly opened: number },
  ): Promise<void>;

  lastEvaluatorRun(
    market: MarketContext,
  ): Promise<{ readonly finishedAt: Temporal.Instant; readonly opened: number } | null>;
}

export const SECURITY_ALERT_REPOSITORY = Symbol('SECURITY_ALERT_REPOSITORY');
