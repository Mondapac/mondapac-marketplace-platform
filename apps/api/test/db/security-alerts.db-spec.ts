import { randomBytes, randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import { ok, Temporal } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { AppModule } from '../../src/app.module';
import { SecurityModule } from '../../src/modules/security';
import {
  SECURITY_ALERT_REPOSITORY,
  type NewAlert,
  type SecurityAlertRepository,
} from '../../src/modules/security/application/ports/security-alert.repository';
import { EvaluateSecurityRules } from '../../src/modules/security/application/use-cases/evaluate-security-rules.use-case';
import { acknowledgeAlert, resolveAlert } from '../../src/modules/security/domain/alert';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import {
  SECURITY_EVENT_FEED,
  type SecurityEventFeed,
} from '../../src/platform/security-events/security-event-feed';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { sqlState } from './sql-state';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// SOC package 2 (docs/design/data/security.md): the security event feed on
// platform.security_events, the alert repository in a real unit, the evaluator end to end, and
// the migration `security_alerts` (CHECKs, the one-live-alert index, the append-only triggers and
// the grants). Every case runs for both Market fixtures.

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const RESTRICT_VIOLATION = '23001';
const INSUFFICIENT_PRIVILEGE = '42501';

const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
/** The real time in whole milliseconds. */
const nowMs = () => Temporal.Instant.fromEpochMilliseconds(Date.now());
/** An IPv4 address of TEST-NET-3 unlikely to be shared with a parallel spec. */
/** A digest period no other run uses: a random past year. */
const year = () => String(1000 + (randomBytes(2).readUInt16BE(0) % 8000)).padStart(4, '0');
const address = () => `203.0.113.${1 + (randomBytes(1)[0]! % 250)}`;

describe('security alerts (database integration, SOC package 2)', () => {
  const clock = new FixedClock(nowMs());
  let app: INestApplicationContext;
  let unitOfWork: UnitOfWork;
  let feed: SecurityEventFeed;
  let alerts: SecurityAlertRepository;
  let evaluator: EvaluateSecurityRules;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ DATABASE_URL: testDatabaseUrl() }),
          logDestination: pino.destination(devNull),
        }),
      ],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    app = await moduleRef.init();
    unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    const security = app.select(SecurityModule);
    feed = security.get<SecurityEventFeed>(SECURITY_EVENT_FEED, { strict: true });
    alerts = security.get<SecurityAlertRepository>(SECURITY_ALERT_REPOSITORY, { strict: true });
    evaluator = security.get(EvaluateSecurityRules, { strict: true });
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });

  afterAll(async () => {
    await owner.end();
    await sql.end();
    await app.close();
  });

  /** Inserts an event row as the owner, `secondsAgo` before the fixed clock. */
  async function event(
    marketId: string,
    fields: {
      readonly type: string;
      readonly at: Temporal.Instant;
      readonly targetId?: string | null;
      readonly ip?: string | null;
      readonly payload?: Record<string, string>;
    },
  ) {
    await owner.query(
      `INSERT INTO platform.security_events
         (id, market_id, tenant_id, occurred_at, type, severity, actor_type, target_type,
          target_id, ip, payload, correlation_id)
       VALUES ($1, $2, $3, $4, $5, 's4', 'ANONYMOUS', $6, $7, $8, $9, 'secalert-db')`,
      [
        randomUUID(),
        marketId,
        PLATFORM_TENANT_ID,
        new Date(fields.at.epochMilliseconds).toISOString(),
        fields.type,
        fields.targetId ? 'account' : null,
        fields.targetId ?? null,
        fields.ip ?? null,
        JSON.stringify(fields.payload ?? {}),
      ],
    );
  }

  const inUnit = <T>(market: ReturnType<typeof marketOf>, work: () => Promise<T>) =>
    unitOfWork.run(market, async () => ok(await work()));

  const newAlert = (fields: Partial<NewAlert> = {}): NewAlert => {
    const now = clock.now();
    return {
      id: randomUUID(),
      rule: 'sign-in-failures-account',
      severity: 's2',
      keyType: 'account',
      keyValue: randomUUID(),
      eventCount: 10,
      firstEventAt: now.subtract({ minutes: 4 }),
      lastEventAt: now,
      openedAt: now,
      nextNotifyAt: now,
      ...fields,
    };
  };

  describe.each(TEST_MARKETS)('Market %s', (code) => {
    const market = marketOf(code);

    describe('the security event feed', () => {
      it('groups by account, address and Market, filters the payload and counts a key', async () => {
        // A one-minute window of its own, hours back, so parallel specs do not share it.
        const base = clock.now().subtract({ minutes: 60 * (2 + (randomBytes(1)[0]! % 200)) });
        const window = { since: base, until: base.add({ minutes: 1 }) };
        const account = randomUUID();
        const ip = address();
        for (let index = 0; index < 3; index += 1) {
          await event(code, {
            type: 'identity.sign-in.failed',
            at: base.add({ seconds: index }),
            targetId: account,
            ip,
            payload: { population: index === 0 ? 'admin' : 'seller' },
          });
        }
        await event(code, { type: 'identity.sign-in.failed', at: base.add({ seconds: 5 }), ip });
        const types = ['identity.sign-in.failed'];

        const byAccount = await inUnit(market, () =>
          feed.groups(market, { types, ...window, groupBy: 'account', minCount: 3, limit: 10 }),
        );
        expect(byAccount.ok && byAccount.value).toEqual([
          { key: account, count: 3, firstAt: base, lastAt: base.add({ seconds: 2 }) },
        ]);
        const byAddress = await inUnit(market, () =>
          feed.groups(market, { types, ...window, groupBy: 'ip', minCount: 4, limit: 10 }),
        );
        expect(byAddress.ok && byAddress.value.find((group) => group.key === ip)?.count).toBe(4);
        const byMarket = await inUnit(market, () =>
          feed.groups(market, { types, ...window, groupBy: 'market', minCount: 1, limit: 1 }),
        );
        expect(byMarket.ok && byMarket.value[0]).toMatchObject({ key: code });
        expect(byMarket.ok && byMarket.value[0]!.count).toBeGreaterThanOrEqual(4);

        const admins = await inUnit(market, () =>
          feed.events(market, {
            types,
            ...window,
            payloadEquals: { population: 'admin' },
            limit: 10,
          }),
        );
        expect(admins.ok && admins.value.filter((row) => row.targetId === account)).toHaveLength(1);
        const counted = await inUnit(market, () =>
          feed.count(market, { types, ...window, key: { kind: 'account', value: account } }),
        );
        expect(counted).toEqual(ok(3));

        // The other Market sees none of it.
        const other = marketOf(code === TEST_MARKETS[0] ? TEST_MARKETS[1] : TEST_MARKETS[0]);
        const elsewhere = await inUnit(other, () =>
          feed.count(other, { types, ...window, key: { kind: 'account', value: account } }),
        );
        expect(elsewhere).toEqual(ok(0));
      });

      it('refuses a query outside its limits', async () => {
        const window = { since: clock.now(), until: clock.now().subtract({ minutes: 1 }) };
        await expect(
          inUnit(market, () =>
            feed.count(market, { types: ['identity.sign-in.failed'], ...window, key: null }),
          ),
        ).rejects.toThrow('window');
      });
    });

    describe('the alert repository', () => {
      it('opens one live alert per rule and key, touches it, claims a step and resolves it', async () => {
        const first = newAlert();
        expect(await inUnit(market, () => alerts.open(market, first))).toEqual(ok(true));
        // A racing run cannot open a second live alert for the same rule and key.
        expect(
          await inUnit(market, () => alerts.open(market, { ...first, id: randomUUID() })),
        ).toEqual(ok(false));

        const live = await inUnit(market, () =>
          alerts.findLive(market, first.rule, 'account', first.keyValue),
        );
        expect(live.ok && live.value).toMatchObject({ id: first.id, state: 'open', version: 1 });
        const stored = live.ok ? live.value! : null;

        const touched = await inUnit(market, () =>
          alerts.touch(market, stored!, { eventCount: 12, lastEventAt: clock.now() }),
        );
        expect(touched).toEqual(ok(true));
        const afterTouch = (await inUnit(market, () => alerts.get(market, first.id))) as {
          ok: true;
          value: NonNullable<Awaited<ReturnType<SecurityAlertRepository['get']>>>;
        };
        expect(afterTouch.value).toMatchObject({ eventCount: 12, version: 2 });

        const due = await inUnit(market, () => alerts.due(market, clock.now(), 500));
        expect(due.ok && due.value.some((alert) => alert.id === first.id)).toBe(true);
        const claim = { notifyStep: 1, nextNotifyAt: null };
        expect(
          await inUnit(market, () => alerts.claimStep(market, afterTouch.value, claim)),
        ).toEqual(ok(true));
        // The stale copy loses the race.
        expect(
          await inUnit(market, () => alerts.claimStep(market, afterTouch.value, claim)),
        ).toEqual(ok(false));

        const claimed = (await inUnit(market, () => alerts.get(market, first.id))) as {
          ok: true;
          value: NonNullable<Awaited<ReturnType<SecurityAlertRepository['get']>>>;
        };
        const by = randomUUID();
        const acknowledged = acknowledgeAlert(claimed.value, by, clock.now());
        if (typeof acknowledged === 'string') throw new Error(acknowledged);
        expect(await inUnit(market, () => alerts.saveTransition(market, acknowledged))).toEqual(
          ok(true),
        );
        const resolved = resolveAlert(acknowledged, {
          by,
          at: clock.now(),
          resolution: 'false-positive',
          note: 'A tester locking their own account.',
          s1Resolvers: [],
        });
        if (typeof resolved === 'string') throw new Error(resolved);
        expect(await inUnit(market, () => alerts.saveTransition(market, resolved))).toEqual(
          ok(true),
        );
        expect(await inUnit(market, () => alerts.saveTransition(market, resolved))).toEqual(
          ok(false),
        );

        const last = await inUnit(market, () =>
          alerts.lastResolvedAt(market, first.rule, 'account', first.keyValue),
        );
        expect(last.ok && last.value?.epochMilliseconds).toBe(clock.now().epochMilliseconds);
        // Resolved, the key may open a new live alert.
        expect(
          await inUnit(market, () => alerts.open(market, { ...first, id: randomUUID() })),
        ).toEqual(ok(true));
      });

      it('keeps the timeline, the digest runs and the evaluator run', async () => {
        const alert = newAlert({ severity: 's1', rule: 'payout-account-changes-burst' });
        await inUnit(market, () =>
          alerts.open(market, {
            ...alert,
            keyType: 'market',
            keyValue: code + randomUUID().slice(0, 8),
          }),
        );
        await inUnit(market, () =>
          alerts.recordDeliveries(market, [
            {
              id: randomUUID(),
              alertId: alert.id,
              step: 1,
              recipient: 'hossein',
              channel: 'email',
              outcome: 'sent',
              at: clock.now(),
            },
          ]),
        );
        const timeline = await inUnit(market, () => alerts.deliveriesOf(market, alert.id));
        expect(timeline.ok && timeline.value).toMatchObject([
          { recipient: 'hossein', outcome: 'sent' },
        ]);

        const period = `${year()}-01-15`;
        const run = {
          kind: 'daily' as const,
          period,
          alerts: 2,
          outcome: 'sent' as const,
          sentAt: clock.now(),
        };
        expect(await inUnit(market, () => alerts.recordDigest(market, run))).toEqual(ok(true));
        expect(await inUnit(market, () => alerts.recordDigest(market, run))).toEqual(ok(false));
        expect(await inUnit(market, () => alerts.hasDigest(market, 'daily', period))).toEqual(
          ok(true),
        );

        await inUnit(market, () =>
          alerts.recordEvaluatorRun(market, { finishedAt: clock.now(), opened: 1 }),
        );
        await inUnit(market, () =>
          alerts.recordEvaluatorRun(market, { finishedAt: clock.now(), opened: 0 }),
        );
        const evaluated = await inUnit(market, () => alerts.lastEvaluatorRun(market));
        expect(evaluated.ok && evaluated.value?.opened).toBe(0);
      });
    });

    it('the evaluator opens an alert for ten failed sign-ins of one account in five minutes', async () => {
      const account = randomUUID();
      for (let index = 0; index < 10; index += 1) {
        await event(code, {
          type: 'identity.sign-in.failed',
          at: clock.now().subtract({ seconds: 10 + index }),
          targetId: account,
          ip: address(),
          payload: { population: 'customer' },
        });
      }
      const report = await evaluator.execute(testCallContext(market, 'system'), {});
      expect(report.ok).toBe(true);
      const live = await inUnit(market, () =>
        alerts.findLive(market, 'sign-in-failures-account', 'account', account),
      );
      expect(live.ok && live.value).toMatchObject({
        severity: 's2',
        state: 'open',
        eventCount: 10,
      });
    });

    describe('the migration', () => {
      async function stored(fields: Partial<NewAlert> = {}) {
        const alert = newAlert(fields);
        await inUnit(market, () => alerts.open(market, alert));
        return alert;
      }

      it('never deletes an alert and never changes a resolved one', async () => {
        const alert = await stored();
        expect(await sqlState(sql, 'DELETE FROM security.alerts WHERE id = $1', [alert.id])).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(await sqlState(owner, 'DELETE FROM security.alerts WHERE id = $1', [alert.id])).toBe(
          RESTRICT_VIOLATION,
        );
        // Every change adds exactly one to the version.
        expect(
          await sqlState(sql, 'UPDATE security.alerts SET version = version + 2 WHERE id = $1', [
            alert.id,
          ]),
        ).toBe(RESTRICT_VIOLATION);
        expect(
          await sqlState(
            sql,
            `UPDATE security.alerts SET state = 'resolved', resolved_at = now(), resolved_by = $2,
               resolution = 'duplicate', resolution_note = 'Same as the other one.',
               next_notify_at = NULL, version = version + 1
             WHERE id = $1`,
            [alert.id, randomUUID()],
          ),
        ).toBeNull();
        expect(
          await sqlState(sql, 'UPDATE security.alerts SET version = version + 1 WHERE id = $1', [
            alert.id,
          ]),
        ).toBe(RESTRICT_VIOLATION);
      });

      it('changes only the state columns, and never the identity of an alert', async () => {
        const alert = await stored();
        expect(
          await sqlState(sql, `UPDATE security.alerts SET severity = 's4' WHERE id = $1`, [
            alert.id,
          ]),
        ).toBe(INSUFFICIENT_PRIVILEGE);
        expect(
          await sqlState(
            owner,
            `UPDATE security.alerts SET severity = 's4', version = version + 1 WHERE id = $1`,
            [alert.id],
          ),
        ).toBe(RESTRICT_VIOLATION);
        // A resolved state needs its columns, and an acknowledged alert never reopens.
        expect(
          await sqlState(
            sql,
            `UPDATE security.alerts SET state = 'resolved', version = version + 1 WHERE id = $1`,
            [alert.id],
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await sqlState(
            sql,
            `UPDATE security.alerts SET state = 'acknowledged', acknowledged_at = now(),
               acknowledged_by = $2, next_notify_at = NULL, version = version + 1 WHERE id = $1`,
            [alert.id, randomUUID()],
          ),
        ).toBeNull();
        expect(
          await sqlState(
            sql,
            `UPDATE security.alerts SET state = 'open', acknowledged_at = NULL,
               acknowledged_by = NULL, version = version + 1 WHERE id = $1`,
            [alert.id],
          ),
        ).toBe(RESTRICT_VIOLATION);
      });

      it('never rewrites an acknowledgement, and never moves counts or steps back', async () => {
        const alert = await stored();
        const update = (set: string, values: unknown[] = []) =>
          sqlState(sql, `UPDATE security.alerts SET ${set}, version = version + 1 WHERE id = $1`, [
            alert.id,
            ...values,
          ]);
        expect(await update('event_count = event_count - 1')).toBe(RESTRICT_VIOLATION);
        expect(await update("last_event_at = last_event_at - interval '1 minute'")).toBe(
          RESTRICT_VIOLATION,
        );
        expect(await update('notify_step = 1')).toBeNull();
        expect(await update('notify_step = 0')).toBe(RESTRICT_VIOLATION);
        expect(
          await update(
            "state = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2, next_notify_at = NULL",
            [randomUUID()],
          ),
        ).toBeNull();
        expect(await update('acknowledged_by = $2', [randomUUID()])).toBe(RESTRICT_VIOLATION);
        expect(
          await update(
            `state = 'resolved', acknowledged_at = NULL, acknowledged_by = NULL, resolved_at = now(),
               resolved_by = $2, resolution = 'duplicate', resolution_note = 'Same as the other one.'`,
            [randomUUID()],
          ),
        ).toBe(RESTRICT_VIOLATION);
      });

      it('holds one live alert per rule and key, and checks its values', async () => {
        const alert = await stored();
        const insert = (id: string, severity: string, note: string | null) =>
          sqlState(
            sql,
            `INSERT INTO security.alerts
               (id, market_id, tenant_id, rule, severity, state, key_type, key_value, event_count,
                first_event_at, last_event_at, opened_at, notify_step, resolution_note, version)
             VALUES ($1, $2, $3, $4, $5, 'open', 'account', $6, 10, now(), now(), now(), 0, $7, 1)`,
            [id, code, PLATFORM_TENANT_ID, alert.rule, severity, alert.keyValue, note],
          );
        expect(await insert(randomUUID(), 's2', null)).toBe(UNIQUE_VIOLATION);
        expect(await insert(randomUUID(), 's9', null)).toBe(CHECK_VIOLATION);
      });

      it('keeps the timeline and the digest runs append-only', async () => {
        const alert = await stored();
        const deliveryId = randomUUID();
        await inUnit(market, () =>
          alerts.recordDeliveries(market, [
            {
              id: deliveryId,
              alertId: alert.id,
              step: 1,
              recipient: 'kazem',
              channel: 'sms',
              outcome: 'not-configured',
              at: clock.now(),
            },
          ]),
        );
        expect(
          await sqlState(
            sql,
            `UPDATE security.alert_deliveries SET outcome = 'sent' WHERE id = $1`,
            [deliveryId],
          ),
        ).toBe(INSUFFICIENT_PRIVILEGE);
        expect(
          await sqlState(
            owner,
            `UPDATE security.alert_deliveries SET outcome = 'sent' WHERE id = $1`,
            [deliveryId],
          ),
        ).toBe(RESTRICT_VIOLATION);
        expect(
          await sqlState(owner, 'DELETE FROM security.alert_deliveries WHERE id = $1', [
            deliveryId,
          ]),
        ).toBe(RESTRICT_VIOLATION);
        const period = `${year()}-W03`;
        await inUnit(market, () =>
          alerts.recordDigest(market, {
            kind: 'weekly',
            period,
            alerts: 0,
            outcome: 'no-contact',
            sentAt: clock.now(),
          }),
        );
        expect(
          await sqlState(
            owner,
            'DELETE FROM security.digest_runs WHERE market_id = $1 AND period = $2',
            [code, period],
          ),
        ).toBe(RESTRICT_VIOLATION);
      });
    });
  });
});
