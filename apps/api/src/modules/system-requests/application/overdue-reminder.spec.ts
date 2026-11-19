import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, PendingEvent } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { RegistryMarketZone } from '../infrastructure/registry-market-zone';
import { remindOverdueSystemRequestsJob } from '../presentation/jobs/remind-overdue-system-requests.job';
import type { OverdueReminderDependencies } from './overdue-reminder-flow';
import type { NewRequest } from './ports/request.repository';
import { InMemoryPolicy, InMemoryRequests } from './testing/in-memory-system-requests';
import { RemindOverdueSystemRequests } from './use-cases/remind-overdue-system-requests.use-case';
import { SystemRequestOverdue } from '../domain/events';
import { dueForReminder, startOfMarketDay, waitingDays } from '../domain/overdue';
import type { PolicyArea, ReviewArea } from '../domain/areas';

// The overdue reminders (owner decision of 15 Nov 2026): one event per overdue request per Market
// day, for open requests of reviewed areas only, on both Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const AUTHOR = id<'Account'>(0xa1);
const START = Temporal.Instant.from('2026-11-15T01:00:00Z');
const DUE = START.add({ hours: 7 * 24 });

class RecordingOutbox implements OutboxWriter {
  readonly events: PendingEvent[] = [];
  append(_context: CallContext, events: readonly PendingEvent[]): Promise<void> {
    this.events.push(...events);
    return Promise.resolve();
  }
}

describe('startOfMarketDay and waitingDays', () => {
  it('cuts the day at the zone midnight, not at 24 hours', () => {
    const at = Temporal.Instant.from('2026-11-22T01:00:00Z');
    // 11:00 in Brisbane (+10:00): the day began at 14:00Z the day before.
    expect(startOfMarketDay(at, 'Australia/Brisbane').toString()).toBe('2026-11-21T14:00:00Z');
    // 14:00 in Auckland (+13:00 in summer): the day began at 11:00Z the day before.
    expect(startOfMarketDay(at, 'Pacific/Auckland').toString()).toBe('2026-11-21T11:00:00Z');
  });

  it('counts whole days waited and never goes below zero', () => {
    const zone = 'Australia/Brisbane';
    expect(waitingDays(START, START.add({ hours: 7 * 24 + 5 }), zone)).toBe(7);
    expect(waitingDays(START, START.add({ hours: 47 }), zone)).toBe(2);
    expect(waitingDays(START, START.subtract({ hours: 3 }), zone)).toBe(0);
    // Calendar days, not 24-hour blocks: 23:30 to 00:30 the next local day is one day.
    const late = Temporal.Instant.from('2026-11-15T13:30:00Z'); // 23:30 in Brisbane
    expect(waitingDays(late, late.add({ hours: 1 }), zone)).toBe(1);
  });

  it('counts calendar days across a daylight saving change', () => {
    // Sydney moves to daylight saving on 4 Oct 2026 (the day is 23 hours long); NY ends it on 1 Nov.
    const sydney = 'Australia/Sydney';
    const applied = Temporal.Instant.from('2026-10-03T14:00:00Z'); // 00:00 on 4 Oct 2026 in Sydney
    const zoned = applied.toZonedDateTimeISO(sydney);
    const sameClockNextDay = zoned.add({ days: 1 }).toInstant(); // 23 hours later in real time
    expect(sameClockNextDay.epochMilliseconds - applied.epochMilliseconds).toBe(23 * 3_600_000);
    expect(waitingDays(applied, sameClockNextDay, sydney)).toBe(1);
    const newYork = 'America/New_York';
    const fall = Temporal.Instant.from('2026-11-01T03:00:00Z'); // 23:00 on 31 Oct
    const nextDay = fall.toZonedDateTimeISO(newYork).add({ days: 1 }).toInstant(); // 25 hours
    expect(nextDay.epochMilliseconds - fall.epochMilliseconds).toBe(25 * 3_600_000);
    expect(waitingDays(fall, nextDay, newYork)).toBe(1);
  });

  it('is due only while open, past the review date and not reminded today', () => {
    const base = { status: 'open', reviewDueAt: DUE, lastRemindedAt: null };
    const dayStart = startOfMarketDay(DUE, 'Australia/Brisbane');
    expect(dueForReminder(base, DUE.subtract({ seconds: 1 }), dayStart)).toBe(false);
    expect(dueForReminder(base, DUE, dayStart)).toBe(true);
    expect(dueForReminder({ ...base, status: 'approved' }, DUE, dayStart)).toBe(false);
    expect(dueForReminder({ ...base, lastRemindedAt: DUE }, DUE, dayStart)).toBe(false);
    expect(
      dueForReminder({ ...base, lastRemindedAt: dayStart.subtract({ seconds: 1 }) }, DUE, dayStart),
    ).toBe(true);
  });
});

describe.each([['AU'], ['ZZ']] as const)('overdue reminders in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const system = (ctx = market) => testCallContext(ctx, 'system');
  const gate = createUseCaseGate(markets, {
    check: (context, declaration) =>
      Promise.resolve(
        declaration.rule.kind === 'system' && context.actor.kind === 'system'
          ? ({ allowed: true } as const)
          : ({ allowed: false, denial: { code: 'access.denied' } } as const),
      ),
  });

  let clock: FixedClock;
  let requests: InMemoryRequests;
  let policy: InMemoryPolicy;
  let outbox: RecordingOutbox;
  let remind: RemindOverdueSystemRequests;
  const zone = new RegistryMarketZone(markets);

  const build = (): RemindOverdueSystemRequests =>
    new RemindOverdueSystemRequests(gate, {
      unitOfWork: new FakeUnitOfWork(),
      requests,
      policy,
      outbox,
      zone,
      ids: new SequenceIdGenerator(clock),
      clock,
    } satisfies OverdueReminderDependencies);

  beforeEach(() => {
    clock = new FixedClock(START);
    requests = new InMemoryRequests();
    policy = new InMemoryPolicy();
    outbox = new RecordingOutbox();
    remind = build();
  });

  let next = 1;
  const open = async (
    area: ReviewArea = 'catalogue',
    ctx = market,
    extra: Partial<NewRequest> = {},
  ) => {
    const requestId = id<'SystemRequest'>(0x500 + next);
    next += 1;
    const opened = await requests.open(
      ctx,
      {
        id: requestId,
        area,
        subjectKind: 'settings.market-setting',
        subjectRef: `ref-${next}`,
        mode: 'review',
        risk: 'medium',
        before: { secretBefore: 'old value' },
        after: { secretAfter: 'new value' },
        note: 'a private note about the change',
        requestedBy: AUTHOR,
        appliedAt: START,
        reviewDueAt: DUE,
        ...extra,
      },
      id<'SystemRequestActivity'>(0x900 + next),
    );
    return { id: requestId, number: opened.number };
  };
  const run = async (ctx = market) => {
    const result = await remind.execute(system(ctx), {});
    if (!result.ok) throw new Error(`refused: ${result.error.code}`);
    return result.value.reminded;
  };

  it('reminds nothing before the review date and one reminder at it', async () => {
    const request = await open();
    clock.set(DUE.subtract({ seconds: 1 }));
    expect(await run()).toBe(0);
    clock.set(DUE);
    expect(await run()).toBe(1);
    expect(outbox.events).toHaveLength(1);
    expect(outbox.events[0]).toMatchObject({
      type: SystemRequestOverdue.type,
      aggregateVersion: 1,
      payload: { requestId: request.id, number: request.number, area: 'catalogue', ageDays: 7 },
    });
  });

  it('puts only the id, number, area and age in the event, never the note or the values', async () => {
    await open();
    clock.set(DUE);
    await run();
    const text = JSON.stringify(outbox.events[0]!.payload);
    expect(Object.keys(outbox.events[0]!.payload).sort()).toEqual([
      'ageDays',
      'area',
      'number',
      'requestId',
    ]);
    expect(text).not.toMatch(/private note|secretBefore|secretAfter|old value|new value/);
  });

  it('sends at most one reminder per Market day, also after a restart, and again the next day', async () => {
    await open();
    clock.set(DUE);
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
    // A new use case on the same storage (a worker restart) does not send it again.
    remind = build();
    clock.set(DUE.add({ minutes: 59 }));
    expect(await run()).toBe(0);
    // Past the next midnight in the Market's zone it is reminded again.
    const zoneName = zone.zoneOf(market);
    const tomorrow = DUE.toZonedDateTimeISO(zoneName).add({ days: 1 }).startOfDay().toInstant();
    clock.set(tomorrow.subtract({ seconds: 1 }));
    expect(await run()).toBe(0);
    clock.set(tomorrow);
    expect(await run()).toBe(1);
    expect(outbox.events.map((event) => (event.payload as { ageDays: number }).ageDays)).toEqual([
      7, 8,
    ]);
  });

  it('does not double-send when two runs overlap', async () => {
    await open();
    clock.set(DUE);
    const [a, b] = await Promise.all([run(), build().execute(system(), {})]);
    const total = a + (b.ok ? b.value.reminded : 0);
    expect(total).toBe(1);
    expect(outbox.events).toHaveLength(1);
  });

  it('stops for a decided request', async () => {
    const request = await open();
    clock.set(DUE);
    await requests.decide(market, request.id, {
      status: 'approved',
      decision: 'approved',
      decidedBy: id<'Account'>(0xa2),
      decidedAt: DUE,
      reason: null,
    });
    expect(await run()).toBe(0);
  });

  it('stops for an area turned off, and resumes when it is turned on again', async () => {
    await open('catalogue');
    await open('people');
    clock.set(DUE);
    await policy.setArea(
      market,
      'catalogue' satisfies PolicyArea,
      { enabled: false, risk: 'medium' },
      { version: 1, at: START, by: AUTHOR },
    );
    expect(await run()).toBe(1);
    expect((outbox.events[0]!.payload as { area: string }).area).toBe('people');
    await policy.setArea(
      market,
      'catalogue',
      { enabled: true, risk: 'medium' },
      { version: 2, at: DUE, by: AUTHOR },
    );
    expect(await run()).toBe(1);
    expect((outbox.events[1]!.payload as { area: string }).area).toBe('catalogue');
  });

  it('always reminds the review policy requests, whatever the area settings', async () => {
    await open('review-policy');
    clock.set(DUE);
    expect(await run()).toBe(1);
  });

  it('keeps the Markets apart', async () => {
    await open('catalogue', market);
    await open('catalogue', other);
    clock.set(DUE);
    expect(await run(market)).toBe(1);
    expect(await run(market)).toBe(0);
    expect(await run(other)).toBe(1);
  });

  it('is a system rule: an admin cannot run it', async () => {
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: AUTHOR,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
    );
    expect(await remind.execute(admin, {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
  });

  it('is registered as an hourly job that runs the use case', async () => {
    const job = remindOverdueSystemRequestsJob(remind);
    expect(job.name).toBe('system-requests.remind-overdue-requests');
    expect(job.every.total({ unit: 'minutes' })).toBe(60);
    await open();
    clock.set(DUE);
    await job.run(system() as never);
    expect(outbox.events).toHaveLength(1);
    await job.run(system() as never);
    expect(outbox.events).toHaveLength(1);
  });
});
