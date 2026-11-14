import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  SecurityEventCountQuery,
  SecurityEventFeed,
  SecurityEventGroup,
  SecurityEventGroupQuery,
  SecurityEventListQuery,
  SecurityEventRef,
  SecurityEventSelection,
} from '../../../../platform/security-events/security-event-feed';
import type { SecurityAlert } from '../../domain/alert';
import type { DeliveryChannel, DeliveryOutcome } from '../../domain/delivery';
import type { AlertKeyType } from '../../domain/rules';
import type { OnCallRoster, RosterMember } from '../../domain/roster';
import { SEVERITIES, type SecuritySeverity } from '../../domain/severity';
import type { AlertMessage, AlertMessenger } from '../ports/alert-messenger';
import type { OnCallRosterSource } from '../ports/on-call-roster';
import type {
  AlertDeliveryRecord,
  AlertListQuery,
  DigestRunRecord,
  NewAlert,
  SecurityAlertRepository,
} from '../ports/security-alert.repository';

// In-memory ports of the security module for the application specs. They keep each Market's
// rows apart, as the Prisma adapters do with the unit's Market.

const cmp = (a: Temporal.Instant, b: Temporal.Instant) => Temporal.Instant.compare(a, b);

/** One stored security event, as the feed reads it. */
export interface FakeEvent {
  readonly market: string;
  readonly id: string;
  readonly type: string;
  readonly targetId: string | null;
  readonly ip: string | null;
  readonly payload: Readonly<Record<string, string>>;
  readonly occurredAt: Temporal.Instant;
}

export class FakeEventFeed implements SecurityEventFeed {
  readonly stored: FakeEvent[] = [];

  #select(market: MarketContext, query: SecurityEventSelection): FakeEvent[] {
    return this.stored
      .filter(
        (event) =>
          event.market === market.marketId &&
          query.types.includes(event.type) &&
          cmp(event.occurredAt, query.since) >= 0 &&
          cmp(event.occurredAt, query.until) < 0 &&
          Object.entries(query.payloadEquals ?? {}).every(
            ([key, value]) => event.payload[key] === value,
          ),
      )
      .sort((a, b) => cmp(a.occurredAt, b.occurredAt) || a.id.localeCompare(b.id));
  }

  groups(
    market: MarketContext,
    query: SecurityEventGroupQuery,
  ): Promise<readonly SecurityEventGroup[]> {
    const groups = new Map<string, FakeEvent[]>();
    for (const event of this.#select(market, query)) {
      const key =
        query.groupBy === 'market'
          ? market.marketId
          : query.groupBy === 'account'
            ? event.targetId
            : event.ip;
      if (key === null) continue;
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    return Promise.resolve(
      [...groups.entries()]
        .filter(([, events]) => events.length >= query.minCount)
        .sort(([ka, a], [kb, b]) => b.length - a.length || ka.localeCompare(kb))
        .slice(0, query.limit)
        .map(([key, events]) => ({
          key,
          count: events.length,
          firstAt: events[0]!.occurredAt,
          lastAt: events[events.length - 1]!.occurredAt,
        })),
    );
  }

  events(
    market: MarketContext,
    query: SecurityEventListQuery,
  ): Promise<readonly SecurityEventRef[]> {
    return Promise.resolve(
      this.#select(market, query)
        .slice(0, query.limit)
        .map((event) => ({ id: event.id, targetId: event.targetId, occurredAt: event.occurredAt })),
    );
  }

  count(market: MarketContext, query: SecurityEventCountQuery): Promise<number> {
    const key = query.key;
    return Promise.resolve(
      this.#select(market, query).filter(
        (event) =>
          key === null || (key.kind === 'account' ? event.targetId : event.ip) === key.value,
      ).length,
    );
  }
}

interface StoredAlert extends SecurityAlert {
  readonly market: string;
}

export class InMemorySecurityAlerts implements SecurityAlertRepository {
  readonly alerts: StoredAlert[] = [];
  readonly deliveries: (AlertDeliveryRecord & { readonly market: string })[] = [];
  readonly digests: (DigestRunRecord & { readonly market: string })[] = [];
  readonly runs = new Map<string, { finishedAt: Temporal.Instant; opened: number }>();

  #of(market: MarketContext): StoredAlert[] {
    return this.alerts.filter((alert) => alert.market === market.marketId);
  }

  #replace(next: StoredAlert): void {
    const index = this.alerts.findIndex((alert) => alert.id === next.id);
    this.alerts[index] = next;
  }

  findLive(market: MarketContext, rule: string, keyType: AlertKeyType, keyValue: string) {
    return Promise.resolve(
      this.#of(market).find(
        (alert) =>
          alert.rule === rule &&
          alert.keyType === keyType &&
          alert.keyValue === keyValue &&
          alert.state !== 'resolved',
      ) ?? null,
    );
  }

  lastResolvedAt(market: MarketContext, rule: string, keyType: AlertKeyType, keyValue: string) {
    const resolved = this.#of(market)
      .filter(
        (alert) =>
          alert.rule === rule &&
          alert.keyType === keyType &&
          alert.keyValue === keyValue &&
          alert.resolvedAt !== null,
      )
      .map((alert) => alert.resolvedAt!)
      .sort((a, b) => cmp(b, a));
    return Promise.resolve(resolved[0] ?? null);
  }

  async open(market: MarketContext, alert: NewAlert): Promise<boolean> {
    if ((await this.findLive(market, alert.rule, alert.keyType, alert.keyValue)) !== null) {
      return false;
    }
    this.alerts.push({
      ...alert,
      market: market.marketId,
      state: 'open',
      notifyStep: 0,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
      resolutionNote: null,
      version: 1,
    });
    return true;
  }

  touch(
    market: MarketContext,
    alert: SecurityAlert,
    match: { readonly eventCount: number; readonly lastEventAt: Temporal.Instant },
  ): Promise<boolean> {
    const stored = this.#of(market).find((row) => row.id === alert.id);
    if (stored === undefined || stored.version !== alert.version) return Promise.resolve(false);
    const eventCount = Math.max(stored.eventCount, match.eventCount);
    const lastEventAt =
      cmp(match.lastEventAt, stored.lastEventAt) > 0 ? match.lastEventAt : stored.lastEventAt;
    if (eventCount === stored.eventCount && lastEventAt.equals(stored.lastEventAt)) {
      return Promise.resolve(false);
    }
    this.#replace({ ...stored, eventCount, lastEventAt, version: stored.version + 1 });
    return Promise.resolve(true);
  }

  saveTransition(market: MarketContext, alert: SecurityAlert): Promise<boolean> {
    const stored = this.#of(market).find((row) => row.id === alert.id);
    if (
      stored === undefined ||
      stored.version !== alert.version - 1 ||
      stored.state === 'resolved'
    ) {
      return Promise.resolve(false);
    }
    this.#replace({ ...alert, market: stored.market });
    return Promise.resolve(true);
  }

  claimStep(
    market: MarketContext,
    alert: SecurityAlert,
    next: { readonly notifyStep: number; readonly nextNotifyAt: Temporal.Instant | null },
  ): Promise<boolean> {
    const stored = this.#of(market).find((row) => row.id === alert.id);
    if (
      stored === undefined ||
      stored.version !== alert.version ||
      stored.state !== 'open' ||
      stored.notifyStep !== alert.notifyStep
    ) {
      return Promise.resolve(false);
    }
    this.#replace({ ...stored, ...next, version: stored.version + 1 });
    return Promise.resolve(true);
  }

  due(market: MarketContext, now: Temporal.Instant, limit: number) {
    return Promise.resolve(
      this.#of(market)
        .filter(
          (alert) =>
            alert.state === 'open' &&
            alert.nextNotifyAt !== null &&
            cmp(alert.nextNotifyAt, now) <= 0,
        )
        .sort((a, b) => cmp(a.nextNotifyAt!, b.nextNotifyAt!))
        .slice(0, limit),
    );
  }

  get(market: MarketContext, id: string) {
    return Promise.resolve(this.#of(market).find((alert) => alert.id === id) ?? null);
  }

  list(market: MarketContext, query: AlertListQuery) {
    const order = (a: SecurityAlert, b: SecurityAlert) =>
      a.severity.localeCompare(b.severity) ||
      cmp(b.openedAt, a.openedAt) ||
      b.id.localeCompare(a.id);
    const after = query.after;
    return Promise.resolve(
      this.#of(market)
        .filter(
          (alert) =>
            query.states.includes(alert.state) &&
            query.severities.includes(alert.severity) &&
            (after === null ||
              order(alert, {
                ...alert,
                severity: after.severity,
                openedAt: after.openedAt,
                id: after.id,
              }) > 0),
        )
        .sort(order)
        .slice(0, query.limit),
    );
  }

  liveCounts(market: MarketContext) {
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<
      SecuritySeverity,
      number
    >;
    for (const alert of this.#of(market))
      if (alert.state !== 'resolved') counts[alert.severity] += 1;
    return Promise.resolve(counts);
  }

  countOpened(
    market: MarketContext,
    severity: SecuritySeverity,
    since: Temporal.Instant,
    until: Temporal.Instant,
  ) {
    const rows = this.#of(market).filter((alert) => alert.severity === severity);
    return Promise.resolve({
      opened: rows.filter((a) => cmp(a.openedAt, since) >= 0 && cmp(a.openedAt, until) < 0).length,
      live: rows.filter((a) => a.state !== 'resolved').length,
    });
  }

  recordDeliveries(market: MarketContext, rows: readonly AlertDeliveryRecord[]) {
    this.deliveries.push(...rows.map((row) => ({ ...row, market: market.marketId })));
    return Promise.resolve();
  }

  deliveriesOf(market: MarketContext, alertId: string) {
    return Promise.resolve(
      this.deliveries.filter((row) => row.market === market.marketId && row.alertId === alertId),
    );
  }

  recordDigest(market: MarketContext, run: DigestRunRecord) {
    if (
      this.digests.some(
        (d) => d.market === market.marketId && d.kind === run.kind && d.period === run.period,
      )
    ) {
      return Promise.resolve(false);
    }
    this.digests.push({ ...run, market: market.marketId });
    return Promise.resolve(true);
  }

  hasDigest(market: MarketContext, kind: 'daily' | 'weekly', period: string) {
    return Promise.resolve(
      this.digests.some(
        (d) => d.market === market.marketId && d.kind === kind && d.period === period,
      ),
    );
  }

  recordEvaluatorRun(market: MarketContext, run: { finishedAt: Temporal.Instant; opened: number }) {
    this.runs.set(market.marketId, run);
    return Promise.resolve();
  }

  lastEvaluatorRun(market: MarketContext) {
    return Promise.resolve(this.runs.get(market.marketId) ?? null);
  }
}

export class RecordingMessenger implements AlertMessenger {
  readonly sent: {
    readonly market: string;
    readonly to: string;
    readonly channel: DeliveryChannel;
    readonly message: AlertMessage;
  }[] = [];
  /** Channels that answer `not-configured`, as SMS, call and team chat do today. */
  unconfigured: readonly DeliveryChannel[] = ['sms', 'call', 'team-chat'];
  failing = false;

  send(
    market: MarketContext,
    member: RosterMember,
    channel: DeliveryChannel,
    message: AlertMessage,
  ): Promise<DeliveryOutcome> {
    if (this.unconfigured.includes(channel)) return Promise.resolve('not-configured');
    if (channel === 'email' && member.email === null) return Promise.resolve('no-contact');
    if (this.failing) return Promise.resolve('failed');
    this.sent.push({ market: market.marketId, to: member.code, channel, message });
    return Promise.resolve('sent');
  }
}

export class StaticRoster implements OnCallRosterSource {
  constructor(public value: OnCallRoster | null) {}
  roster(): OnCallRoster | null {
    return this.value;
  }
}

/** A roster like the example file: Sydney hours, three on rotation, Ali and Hassan. */
export function testRoster(accounts: { ali: string; hassan: string }): OnCallRoster {
  const member = (code: string, accountId: string | null, email: string | null) => ({
    code,
    name: code[0]!.toUpperCase() + code.slice(1),
    accountId,
    email,
    phone: '+61400000000',
  });
  return {
    hours: {
      zone: 'Australia/Sydney',
      startMinute: 9 * 60,
      endMinute: 18 * 60,
      days: [1, 2, 3, 4, 5],
    },
    members: [
      member('kazem', null, 'kazem@example.test'),
      member('hossein', null, 'hossein@example.test'),
      member('mojtaba', null, null),
      member('ali', accounts.ali, 'ali@example.test'),
      member('hassan', accounts.hassan, 'hassan@example.test'),
    ],
    rotation: ['kazem', 'hossein', 'mojtaba'],
    // A Monday, 09:00 Sydney.
    rotationStart: Temporal.PlainDateTime.from('2026-11-02T09:00'),
    incidentCommander: 'ali',
    securityOwner: 'hassan',
  };
}
