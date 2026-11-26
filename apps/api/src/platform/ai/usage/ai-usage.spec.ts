import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import { inMemoryAiUsage } from '../../../../test/support/in-memory-ai-usage';
import { capsOfBudget } from '../../../../test/support/ai-gateway-controls';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../market-config/market-config';
import { MarketRegistry } from '../../market-config/market-registry';
import { NO_CAPS, type AiCaps } from '../gateway-controls';
import type { SettledCall, UsageScope } from './ai-usage';

// AI Gateway G4d2 (docs/design/domain/platform-ai.md section 7): a capability's own day and month
// caps, held at reservation on its day line and its month line (the month in the Market's zone),
// both Market fixtures. AU's zone is Australia/Brisbane (UTC+10), ZZ's Asia/Tokyo (UTC+9), so
// 30 Nov 14:30 UTC is 1 December in AU and still 30 November in ZZ.

const CHAT = 'alpha.buyer-chat';
const SCOPE: UsageScope = { capability: CHAT, sellerId: null, guest: false };
const TTL = Temporal.Duration.from({ minutes: 1 });
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

const chatCaps = (
  day: number | null,
  month: number | null,
  extra: Partial<AiCaps> = {},
): AiCaps => ({
  ...NO_CAPS,
  ...extra,
  capabilities: { [CHAT]: { day, month } },
});

const settled = (cost: number): SettledCall => ({
  occurredAt: Temporal.Instant.from('2026-11-25T10:00:00Z'),
  provider: 'anthropic',
  model: 'model-fast',
  attempt: 1,
  fallback: false,
  inputTokens: 1,
  outputTokens: 1,
  inputPicoUsd: 1,
  outputPicoUsd: 1,
  costMicroUsd: cost,
  latencyMs: 10,
  outcome: 'ok',
});

describe.each([
  ['AU', '2026-12-01', '2026-12-01'],
  ['ZZ', '2026-11-30', '2026-11-01'],
])('AiUsage capability caps (G4d2), Market %s', (code, marketDay, monthStart) => {
  const market = testMarketContext(code, 'default');
  const at = Temporal.Instant.from('2026-11-30T14:30:00Z');
  const setUp = () => {
    const clock = new FixedClock(at);
    return { clock, ...inMemoryAiUsage(markets, clock) };
  };

  it('holds every reservation on the capability day and month lines, the month in the Market zone', async () => {
    const { usage, store } = setUp();
    const lines = usage.linesOf(market, SCOPE, usage.dayOf(market, at), NO_CAPS);
    expect(lines.map((line) => [line.period, line.periodStart.toString(), line.scope])).toEqual([
      ['day', marketDay, 'capability'],
      ['month', monthStart, 'capability'],
      ['day', marketDay, 'market'],
      ['month', monthStart, 'market'],
    ]);
    const reservation = await usage.reserve(market, SCOPE, NO_CAPS, 300, TTL);
    expect(reservation).not.toBe('over-budget');
    const month = store.counterOf(market, {
      period: 'month',
      periodStart: Temporal.PlainDate.from(monthStart),
      scope: 'capability',
      scopeKey: CHAT,
    });
    expect(month).toEqual({ held: 300, spent: 0 });
    expect([...store.reservations.values()][0]).toMatchObject({ capabilityMonth: true });
  });

  it('refuses at reservation a call the day cap or the month cap cannot take', async () => {
    const { usage, clock } = setUp();
    const caps = chatCaps(1000, 1500);
    const first = await usage.reserve(market, SCOPE, caps, 600, TTL);
    if (first === 'over-budget') throw new Error('unexpected');
    await usage.settle(market, first, settled(600));
    // The day has 400 left: a call of 600 is refused, one of 400 fits.
    expect(await usage.reserve(market, SCOPE, caps, 600, TTL)).toBe('over-budget');
    expect(await usage.capabilityCapFull(market, CHAT, caps, 600)).toBe('day');
    const second = await usage.reserve(market, SCOPE, caps, 400, TTL);
    if (second === 'over-budget') throw new Error('unexpected');
    await usage.settle(market, second, settled(400));
    expect(await usage.capabilityCapFull(market, CHAT, caps, 1)).toBe('day');
    // The next Market day the day cap starts again; the month has 500 left if it is the same one.
    clock.set(Temporal.Instant.from('2026-12-01T16:00:00Z'));
    const sameMonth = code === 'AU';
    if (sameMonth) {
      // AU: 2 December, still December's month counter with 1000 held.
      expect(await usage.capabilityCapFull(market, CHAT, caps, 600)).toBe('month');
      expect(await usage.reserve(market, SCOPE, caps, 600, TTL)).toBe('over-budget');
      expect(await usage.reserve(market, SCOPE, caps, 500, TTL)).not.toBe('over-budget');
    } else {
      // ZZ: 2 December is a new month and a new day.
      expect(await usage.capabilityCapFull(market, CHAT, caps, 600)).toBeNull();
      expect(await usage.reserve(market, SCOPE, caps, 1000, TTL)).not.toBe('over-budget');
    }
  });

  it('takes the stricter of the capability’s own day cap and the general capability-day cap', () => {
    const { usage } = setUp();
    const day = usage.dayOf(market, at);
    const capOf = (caps: AiCaps) =>
      usage
        .linesOf(market, SCOPE, day, caps)
        .filter((line) => line.scope === 'capability')
        .map((line) => [line.period, line.capMicroUsd]);
    expect(capOf(chatCaps(1000, 5000, { capabilityDay: 700 }))).toEqual([
      ['day', 700],
      ['month', 5000],
    ]);
    expect(capOf(chatCaps(500, null, { capabilityDay: 700 }))).toEqual([
      ['day', 500],
      ['month', null],
    ]);
    expect(capOf(chatCaps(null, null, { capabilityDay: 700 }))).toEqual([
      ['day', 700],
      ['month', null],
    ]);
    // Another capability has only the general caps.
    expect(
      usage
        .linesOf(market, { ...SCOPE, capability: 'alpha.other' }, day, chatCaps(1, 1))
        .filter((line) => line.scope === 'capability')
        .map((line) => line.capMicroUsd),
    ).toEqual([null, null]);
    // A capability id that is a key of the object prototype is never a cap entry.
    expect(
      usage
        .linesOf(market, { ...SCOPE, capability: 'constructor' }, day, NO_CAPS)
        .filter((line) => line.scope === 'capability')
        .map((line) => line.capMicroUsd),
    ).toEqual([null, null]);
  });

  it('counts a month cap set in the middle of a month against the whole month', async () => {
    const { usage } = setUp();
    const uncapped = await usage.reserve(market, SCOPE, NO_CAPS, 900, TTL);
    if (uncapped === 'over-budget') throw new Error('unexpected');
    await usage.settle(market, uncapped, settled(900));
    // Set now: the 900 spent before counts.
    expect(await usage.reserve(market, SCOPE, chatCaps(null, 1000), 200, TTL)).toBe('over-budget');
    expect(await usage.capabilityCapFull(market, CHAT, chatCaps(null, 1000), 200)).toBe('month');
  });

  it('settles and sweeps a reservation made before G4d2 without touching the month line', async () => {
    const { usage, store, clock } = setUp();
    const day = usage.dayOf(market, at);
    const reservation = await usage.reserve(market, SCOPE, NO_CAPS, 500, TTL);
    if (reservation === 'over-budget') throw new Error('unexpected');
    // As the release before G4d2 wrote it: no month line held.
    const record = store.reservations.get(reservation.id)!;
    store.reservations.set(reservation.id, { ...record, capabilityMonth: false });
    const monthKey = {
      period: 'month' as const,
      periodStart: day.with({ day: 1 }),
      scope: 'capability' as const,
      scopeKey: CHAT,
    };
    store.counters.delete(
      `${market.marketId}|month|${monthKey.periodStart.toString()}|capability|${CHAT}`,
    );
    await usage.settle(market, reservation, settled(200));
    expect(store.counterOf(market, monthKey)).toBeUndefined();
    expect(store.counterOf(market, { ...monthKey, period: 'day', periodStart: day })).toEqual({
      held: 200,
      spent: 200,
    });

    const swept = await usage.reserve(market, SCOPE, NO_CAPS, 300, TTL);
    if (swept === 'over-budget') throw new Error('unexpected');
    const old = store.reservations.get(swept.id)!;
    store.reservations.set(swept.id, { ...old, capabilityMonth: false });
    store.counters.delete(
      `${market.marketId}|month|${monthKey.periodStart.toString()}|capability|${CHAT}`,
    );
    clock.advance(Temporal.Duration.from({ minutes: 5 }));
    expect((await usage.sweep(market)).released).toBe(1);
    expect(store.counterOf(market, monthKey)).toBeUndefined();
  });

  it('enforces each line on its own when a revert left the day cap above the month cap (Hassan L3)', async () => {
    const { usage } = setUp();
    const caps = chatCaps(1000, 400);
    expect(await usage.reserve(market, SCOPE, caps, 500, TTL)).toBe('over-budget');
    expect(await usage.capabilityCapFull(market, CHAT, caps, 500)).toBe('month');
    const fits = await usage.reserve(market, SCOPE, caps, 400, TTL);
    expect(fits).not.toBe('over-budget');
    expect(await usage.reserve(market, SCOPE, caps, 1, TTL)).toBe('over-budget');
  });

  it('answers no full cap when the capability has none of its own', async () => {
    const { usage } = setUp();
    expect(
      await usage.capabilityCapFull(market, CHAT, capsOfBudget({ marketDayMicroUsd: 0 })),
    ).toBe(null);
  });
});
