import { randomUUID } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import {
  acknowledgeAlert,
  resolveAlert,
  type SecurityAlert,
} from '../../src/modules/security/domain/alert';
import {
  ALERT_LIST_VIEWS,
  alertMatches,
  compareAlerts,
  EMPTY_ALERT_LIST_FILTER,
  type AlertListFilter,
  type AlertSort,
} from '../../src/modules/security/domain/alert-list';
import type { NewAlert } from '../../src/modules/security/application/ports/security-alert.repository';
import { PrismaSecurityAlertRepository } from '../../src/modules/security/infrastructure/prisma-security-alert.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The security alert list on PostgreSQL (super list 37), for both Market fixtures: the repository's
// views, filters, sorts, counts, id lookups and page windows against the in-memory twin
// (`alertMatches`, `compareAlerts`) that the unit specs use. Alerts of all states and severities,
// and one of the other Market that must never show.

describe.each(TEST_MARKETS)('security alert list in market %s (database)', (code) => {
  const market = marketOf(code);
  const foreign = marketOf(otherMarketOf(code));
  // Other specs put alerts into the same Market at the current time: every read here is limited to
  // March of a year only this spec writes to, a different one for each Market, so the alert this
  // run puts into the other Market never lands in the other run's window.
  const T0 = Temporal.Instant.from(`${2001 + TEST_MARKETS.indexOf(code)}-03-01T00:00:00Z`);
  const WINDOW = { from: T0.subtract({ hours: 24 }), to: T0.add({ hours: 24 * 30 }) };

  let db: Persistence;
  let repository: PrismaSecurityAlertRepository;
  const subjects: SecurityAlert[] = [];

  const inUnit = <T>(market_: typeof market, work: () => Promise<T>) =>
    db.unitOfWork.run(market_, async () => ok(await work()));

  const open = async (
    market_: typeof market,
    fields: Partial<NewAlert> & { day: number },
  ): Promise<NewAlert> => {
    const { day, ...rest } = fields;
    const at = T0.add({ hours: 24 * day });
    const alert: NewAlert = {
      id: randomUUID(),
      rule: 'sign-in-failures-account',
      severity: 's2',
      keyType: 'account',
      keyValue: randomUUID(),
      eventCount: 10,
      firstEventAt: at.subtract({ minutes: 4 }),
      lastEventAt: at,
      openedAt: at,
      nextNotifyAt: null,
      ...rest,
    };
    expect(await inUnit(market_, () => repository.open(market_, alert))).toEqual(ok(true));
    return alert;
  };

  const loaded = async (id: string): Promise<SecurityAlert> => {
    const got = await inUnit(market, () => repository.get(market, id));
    if (!got.ok || got.value === null) throw new Error('missing alert');
    return got.value;
  };

  beforeAll(async () => {
    db = createPersistence();
    repository = new PrismaSecurityAlertRepository(db.service);
    const plan = [
      { day: 1, severity: 's1' as const, rule: 'admin-sign-in-after-failures', eventCount: 3 },
      { day: 2, severity: 's2' as const, eventCount: 40 },
      {
        day: 3,
        severity: 's2' as const,
        eventCount: 40,
        keyType: 'ip' as const,
        keyValue: '203.0.113.7',
        rule: 'sign-in-failures-ip',
      },
      { day: 3, severity: 's3' as const, eventCount: 12 },
      {
        day: 4,
        severity: 's1' as const,
        eventCount: 7,
        rule: 'payout-account-changes-burst',
        keyType: 'market' as const,
        keyValue: `${code}-burst`,
      },
      { day: 5, severity: 's4' as const, eventCount: 100 },
    ];
    const by = randomUUID();
    for (const [index, row] of plan.entries()) {
      const made = await open(market, row);
      let alert = await loaded(made.id);
      // The second alert is acknowledged, the third and the fifth resolved.
      if (index === 1 || index === 2 || index === 4) {
        const acknowledged = acknowledgeAlert(alert, by, T0.add({ hours: 24 * 6 }));
        if (typeof acknowledged === 'string') throw new Error(acknowledged);
        expect(await inUnit(market, () => repository.saveTransition(market, acknowledged))).toEqual(
          ok(true),
        );
        alert = acknowledged;
      }
      if (index === 2 || index === 4) {
        const resolved = resolveAlert(alert, {
          by,
          at: T0.add({ hours: 24 * 7 }),
          resolution: 'contained',
          note: 'Handled by the on-call responder.',
          s1Resolvers: [by],
        });
        if (typeof resolved === 'string') throw new Error(resolved);
        expect(await inUnit(market, () => repository.saveTransition(market, resolved))).toEqual(
          ok(true),
        );
        alert = resolved;
      }
      subjects.push(alert);
    }
    // An alert of the other Market in the same window must not change what this Market lists.
    await open(foreign, { day: 1 });
  });
  afterAll(async () => {
    await db.close();
  });

  const windowed = (filter: AlertListFilter): AlertListFilter => ({
    ...filter,
    from: filter.from ?? WINDOW.from,
    to: filter.to ?? WINDOW.to,
  });
  const read = (filter: AlertListFilter, sort: AlertSort, offset = 0, limit = 50) =>
    inUnit(market, () => repository.queryList(market, windowed(filter), sort, offset, limit));

  const FILTERS: readonly [string, Partial<AlertListFilter>][] = [
    ['all', {}],
    ['open', { view: 'open' }],
    ['acknowledged', { view: 'acknowledged' }],
    ['critical', { view: 'critical' }],
    ['resolved', { view: 'resolved' }],
    ['severity', { severities: ['s1', 's3'] }],
    ['rule', { rule: 'sign-in-failures-ip' }],
    ['key type', { keyType: 'ip' }],
    ['key value', { keyValue: '203.0.113.7' }],
    ['key value none', { keyValue: '203.0.113.%' }],
    ['events', { minEvents: 40 }],
    ['from', { from: T0.add({ hours: 24 * 3 }) }],
    ['to', { to: T0.add({ hours: 24 * 3 }) }],
    ['critical in range', { view: 'critical', minEvents: 5 }],
  ];
  const SORTS: readonly AlertSort[] = [
    { key: 'severity', direction: 'asc' },
    { key: 'severity', direction: 'desc' },
    { key: 'opened', direction: 'asc' },
    { key: 'opened', direction: 'desc' },
    { key: 'events', direction: 'asc' },
    { key: 'events', direction: 'desc' },
    { key: 'last-event', direction: 'asc' },
    { key: 'last-event', direction: 'desc' },
  ];

  it.each(FILTERS)('matches the in-memory twin: %s', async (_name, partial) => {
    const filter = windowed({ ...EMPTY_ALERT_LIST_FILTER, ...partial });
    for (const sort of SORTS) {
      const expected = subjects
        .filter((s) => alertMatches(s, filter))
        .sort((a, b) => compareAlerts(a, b, sort))
        .map((s) => s.id);
      const got = await read(filter, sort);
      expect(got.ok && got.value.map((row) => row.id)).toEqual(expected);
      const count = await inUnit(market, () => repository.countListWhere(market, filter));
      expect(count.ok && count.value).toBe(expected.length);
    }
  });

  it('pages without repeating or skipping a row', async () => {
    const sort = SORTS[4]!;
    const all = await read(EMPTY_ALERT_LIST_FILTER, sort);
    const seen: string[] = [];
    for (let offset = 0; offset < subjects.length; offset += 2) {
      const page = await read(EMPTY_ALERT_LIST_FILTER, sort, offset, 2);
      if (page.ok) seen.push(...page.value.map((row) => row.id));
    }
    expect(seen).toEqual(all.ok ? all.value.map((row) => row.id) : null);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('counts each view for the Market and finds alerts by id in its Market only', async () => {
    const counts = await inUnit(market, () => repository.viewCounts(market));
    // Other specs may have alerts in the Market too: each view holds at least this spec's own.
    for (const view of ALERT_LIST_VIEWS) {
      const own = subjects.filter((s) =>
        alertMatches(s, { ...EMPTY_ALERT_LIST_FILTER, view }),
      ).length;
      expect(counts.ok && counts.value[view]).toBeGreaterThanOrEqual(own);
    }
    const foreignOne = await open(foreign, { day: 2 });
    const found = await inUnit(market, () =>
      repository.findByIds(market, [subjects[0]!.id, subjects[1]!.id, foreignOne.id]),
    );
    expect(found.ok && found.value.map((row) => row.id).sort()).toEqual(
      [subjects[0]!.id, subjects[1]!.id].sort(),
    );
    expect(await inUnit(market, () => repository.findByIds(market, []))).toEqual(ok([]));
  });
});
