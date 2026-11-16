import { randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { AppModule } from '../../src/app.module';
import { SystemRequestsModule } from '../../src/modules/system-requests';
import {
  REQUEST_REPOSITORY,
  type NewRequest,
  type RequestRepository,
} from '../../src/modules/system-requests/application/ports/request.repository';
import { RemindOverdueSystemRequests } from '../../src/modules/system-requests/application/use-cases/remind-overdue-system-requests.use-case';
import {
  MARKET_ZONE,
  type MarketZone,
} from '../../src/modules/system-requests/application/ports/market-zone';
import {
  POLICY_REPOSITORY,
  type PolicyRepository,
} from '../../src/modules/system-requests/application/ports/policy.repository';
import { startOfMarketDay } from '../../src/modules/system-requests/domain/overdue';
import { USE_CASE_GATE, type UseCaseGate } from '../../src/platform/authz';
import { OUTBOX_WRITER, type OutboxWriter } from '../../src/platform/events/outbox-writer';
import { ID_GENERATOR } from '../../src/platform/ids/ids.module';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { ids } from './outbox-support';
import { testDatabaseUrl } from './test-database';

// Overdue reminders of system requests (owner decision of 15 Nov 2026) on a real database: the
// conditional stamp `last_reminded_at`, the reminder use case with the module's real outbox, and
// the once-per-day rule. Every case runs for both Market fixtures.

const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
/**
 * The test's "now" in a Market: noon of a fixed local day in the Market's zone, so no run can
 * straddle the Market's midnight whatever the zone (Brisbane, Tokyo, ...) and the real time of day.
 */
const FIXED_DAY = Temporal.Instant.from('2026-11-16T12:00:00Z');
const account = () => randomUUID() as Id<'Account'>;

describe('system request reminders (database integration)', () => {
  let app: INestApplicationContext;
  let unitOfWork: UnitOfWork;
  let requests: RequestRepository;
  let policy: PolicyRepository;
  let zone: MarketZone;
  let reminderDeps: ConstructorParameters<typeof RemindOverdueSystemRequests>[1];
  let gate: UseCaseGate;
  let sql: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ DATABASE_URL: testDatabaseUrl() }),
          logDestination: pino.destination(devNull),
        }),
      ],
    }).compile();
    app = await moduleRef.init();
    unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    const module = app.select(SystemRequestsModule);
    requests = module.get<RequestRepository>(REQUEST_REPOSITORY, { strict: true });
    policy = module.get<PolicyRepository>(POLICY_REPOSITORY, { strict: true });
    zone = module.get<MarketZone>(MARKET_ZONE, { strict: true });
    gate = module.get<UseCaseGate>(USE_CASE_GATE, { strict: false });
    reminderDeps = {
      unitOfWork,
      requests,
      policy,
      outbox: module.get<OutboxWriter>(OUTBOX_WRITER, { strict: true }),
      zone,
      ids: app.get(ID_GENERATOR),
      clock: new FixedClock(FIXED_DAY),
    };
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  const inUnit = async <T>(market: ReturnType<typeof marketOf>, work: () => Promise<T>) => {
    const result = await unitOfWork.run(market, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  /** Noon of the fixed day in the Market's zone. */
  const noonIn = (market: ReturnType<typeof marketOf>): Temporal.Instant =>
    startOfMarketDay(FIXED_DAY, zone.zoneOf(market)).add({ hours: 12 });
  /** A request that went live 8 days before `now`, so its review date (7 days) is past. */
  const overdue = (
    market: ReturnType<typeof marketOf>,
    fields: Partial<NewRequest> = {},
  ): NewRequest => {
    const appliedAt = noonIn(market).subtract({ hours: 8 * 24 });
    return {
      id: ids.next<'SystemRequest'>(),
      area: 'catalogue',
      subjectKind: 'settings.market-setting',
      subjectRef: `ref-${randomUUID()}`,
      risk: 'medium',
      before: { size: 25 },
      after: { size: 50 },
      note: 'a private note about the change',
      requestedBy: account(),
      appliedAt,
      reviewDueAt: appliedAt.add({ hours: 7 * 24 }),
      ...fields,
    };
  };
  const open = (market: ReturnType<typeof marketOf>, request: NewRequest) =>
    inUnit(market, () =>
      requests.open(market, request, randomUUID() as Id<'SystemRequestActivity'>),
    );
  const events = async (market: ReturnType<typeof marketOf>, request: NewRequest) =>
    (
      await sql.query(
        `SELECT type, payload FROM system_requests.outbox
          WHERE market_id = $1 AND payload->>'requestId' = $2`,
        [market.marketId, request.id],
      )
    ).rows as { type: string; payload: Record<string, unknown> }[];
  /** The use case with a clock fixed at `at` (default: noon of the fixed day in the Market). */
  const reminderAt = (market: ReturnType<typeof marketOf>, at = noonIn(market)) =>
    new RemindOverdueSystemRequests(gate, { ...reminderDeps, clock: new FixedClock(at) });
  const callOf = (market: ReturnType<typeof marketOf>) =>
    testCallContext(market, 'system', `db-sr-${randomUUID()}`);
  const run = async (market: ReturnType<typeof marketOf>, at?: Temporal.Instant) => {
    const result = await reminderAt(market, at).execute(callOf(market), {});
    if (!result.ok) throw new Error(`refused: ${result.error.code}`);
    return result.value.reminded;
  };

  describe.each(TEST_MARKETS.map((code) => [code]))('in market %s', (code) => {
    const market = marketOf(code);
    const otherMarket = marketOf(TEST_MARKETS.find((c) => c !== code)!);

    it('stamps a reminder once under its condition, in a real unit', async () => {
      const request = overdue(market);
      await open(market, request);
      const now = noonIn(market);
      const dayStart = startOfMarketDay(now, zone.zoneOf(market));
      const due = await inUnit(market, () =>
        requests.dueForReminder(market, {
          now,
          remindedBefore: dayStart,
          areas: ['catalogue'],
          limit: 1000,
        }),
      );
      expect(due.map((row) => row.id)).toContain(request.id);
      expect(
        await inUnit(market, () => requests.markReminded(market, request.id, now, dayStart)),
      ).toBe(true);
      // Not again until the next day starts.
      expect(
        await inUnit(market, () => requests.markReminded(market, request.id, now, dayStart)),
      ).toBe(false);
      const after = await inUnit(market, () =>
        requests.dueForReminder(market, {
          now,
          remindedBefore: dayStart,
          areas: ['catalogue'],
          limit: 1000,
        }),
      );
      expect(after.map((row) => row.id)).not.toContain(request.id);
      // The other Market sees nothing of it.
      expect(
        await inUnit(otherMarket, () =>
          requests.markReminded(otherMarket, request.id, now, now.add({ hours: 1 })),
        ),
      ).toBe(false);
    });

    it('writes one reminder event for an overdue request, and none on a second run the same day', async () => {
      const request = overdue(market);
      await open(market, request);
      expect(await run(market)).toBeGreaterThanOrEqual(1);
      const rows = await events(market, request);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe('system-requests.request-overdue.v1');
      expect(rows[0]!.payload).toMatchObject({ area: 'catalogue', ageDays: 8 });
      expect(Object.keys(rows[0]!.payload).sort()).toEqual([
        'ageDays',
        'area',
        'number',
        'requestId',
      ]);
      await run(market);
      expect(await events(market, request)).toHaveLength(1);
      const stored = await sql.query<{ last_reminded_at: Date | null }>(
        'SELECT last_reminded_at FROM system_requests.requests WHERE id = $1',
        [request.id],
      );
      expect(stored.rows[0]!.last_reminded_at?.getTime()).toBe(noonIn(market).epochMilliseconds);
    });

    it('reminds again after the Market midnight, never before it', async () => {
      const request = overdue(market);
      await open(market, request);
      await run(market);
      const midnight = startOfMarketDay(noonIn(market), zone.zoneOf(market))
        .toZonedDateTimeISO(zone.zoneOf(market))
        .add({ days: 1 })
        .toInstant();
      await run(market, midnight.subtract({ seconds: 1 }));
      expect(await events(market, request)).toHaveLength(1);
      await run(market, midnight);
      const rows = await events(market, request);
      expect(rows.map((row) => row.payload.ageDays)).toEqual(expect.arrayContaining([8, 9]));
      expect(rows).toHaveLength(2);
    });

    it('writes exactly one event and one stamp when two runs overlap', async () => {
      const request = overdue(market);
      await open(market, request);
      const [first, second] = await Promise.all([
        reminderAt(market).execute(callOf(market), {}),
        reminderAt(market).execute(callOf(market), {}),
      ]);
      expect(first.ok && second.ok).toBe(true);
      expect(await events(market, request)).toHaveLength(1);
      const stamped = await sql.query<{ last_reminded_at: Date | null }>(
        'SELECT last_reminded_at FROM system_requests.requests WHERE id = $1',
        [request.id],
      );
      expect(stamped.rows[0]!.last_reminded_at?.getTime()).toBe(noonIn(market).epochMilliseconds);
    });

    it('does not remind a request that is not yet due, a decided one, or one of an area that is off', async () => {
      const notDue = overdue(market, {
        appliedAt: noonIn(market),
        reviewDueAt: noonIn(market).add({ hours: 7 * 24 }),
      });
      const decided = overdue(market);
      // Marketplace is not reviewed by default: its requests are not reminded.
      const off = overdue(market, { area: 'marketplace' });
      for (const request of [notDue, decided, off]) await open(market, request);
      await inUnit(market, () =>
        requests.decide(market, decided.id, {
          status: 'approved',
          decision: 'approved',
          decidedBy: account(),
          decidedAt: noonIn(market),
          reason: null,
        }),
      );
      await run(market);
      expect(await events(market, notDue)).toHaveLength(0);
      expect(await events(market, decided)).toHaveLength(0);
      expect(await events(market, off)).toHaveLength(0);
    });

    it('reminds one Market without touching the other', async () => {
      const here = overdue(market);
      const there = overdue(otherMarket);
      await open(market, here);
      await open(otherMarket, there);
      await run(market);
      expect(await events(market, here)).toHaveLength(1);
      expect(await events(otherMarket, there)).toHaveLength(0);
    });
  });
});
