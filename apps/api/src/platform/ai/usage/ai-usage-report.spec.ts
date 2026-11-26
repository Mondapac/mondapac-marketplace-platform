import { Temporal } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { CapabilityRegistry } from '../capability-registry';
import type { CapabilitySpec } from '../capability';
import { InMemoryAiUsageStore } from '../../../../test/support/in-memory-ai-usage';
import { PLATFORM_TENANT_ID } from '../../market-context/tenant';
import { MarketRegistry } from '../../market-config/market-registry';
import { loadMarketConfigs } from '../../market-config/market-config';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AiGateway } from '../ai-gateway';
import { AiUsageReport } from './ai-usage-report';

const SPEC: CapabilitySpec = {
  id: 'alpha.chat',
  audience: 'buyer',
  task: 'chat',
  sellerScoped: false,
  maxInputTokens: 1000,
  maxOutputTokens: 100,
  maxToolRounds: 1,
  timeoutMs: 1000,
  promptVersion: 'v1',
};

describe('AiUsageReport (AI Gateway G7)', () => {
  const day = Temporal.PlainDate.from('2026-11-25');
  const at = Temporal.Instant.from('2026-11-25T03:00:00Z');

  const asked: string[] = [];

  function setUp() {
    const registry = new CapabilityRegistry();
    registry.register('alpha', [SPEC]);
    registry.register('beta', [{ ...SPEC, id: 'beta.write', task: 'write' }]);
    const store = new InMemoryAiUsageStore();
    const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
    const gateway = {
      capabilityCapReached: (capability: string) => {
        asked.push(capability);
        return Promise.resolve('month' as const);
      },
    } as unknown as AiGateway;
    return { store, report: new AiUsageReport(store, registry, markets, gateway).for('alpha') };
  }

  it('gives the owner platform no handle: platform.ai-evaluation is the evaluation budget (G4c)', () => {
    const registry = new CapabilityRegistry();
    const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
    const report = new AiUsageReport(
      new InMemoryAiUsageStore(),
      registry,
      markets,
      {} as unknown as AiGateway,
    );
    expect(() => report.for('platform')).toThrow('"platform" has no AI capability');
  });

  describe.each(['AU', 'ZZ'])('Market %s', (code) => {
    const market = testMarketContext(code, PLATFORM_TENANT_ID);

    it('answers a capability’s spent per day from its day counters, its own only, within the range', async () => {
      const { store, report } = setUp();
      // The capability's day counters, as reserve and settle (or the sweeper) leave them.
      const row = (on: string, capability: string, spent: number, scope = 'capability') =>
        store.counters.set(`${market.marketId}|day|${on}|${scope}|${capability}`, {
          held: spent,
          spent,
        });
      row('2026-11-24', 'alpha.chat', 100);
      row('2026-11-25', 'alpha.chat', 250);
      row('2026-11-25', 'alpha.chat', 999, 'seller');
      row('2026-11-25', 'beta.write', 999);
      row('2026-11-26', 'alpha.chat', 7);
      await expect(
        report.costByDay(market, 'alpha.chat', day.subtract({ days: 1 }), day),
      ).resolves.toEqual([
        { day: Temporal.PlainDate.from('2026-11-24'), costMicroUsd: 100 },
        { day, costMicroUsd: 250 },
      ]);
    });

    it('keeps one cap-reached record a day and answers the newest', async () => {
      const { report } = setUp();
      await expect(report.lastCapReached(market, 'alpha.chat')).resolves.toBeNull();
      await expect(report.markCapReached(market, 'alpha.chat', day, 'month', at)).resolves.toBe(
        true,
      );
      await expect(
        report.markCapReached(market, 'alpha.chat', day, 'day', at.add({ hours: 1 })),
      ).resolves.toBe(false);
      const last = await report.lastCapReached(market, 'alpha.chat');
      // Temporal instants compare by their text (toEqual sees no fields on them).
      expect([last?.at.toString(), last?.period]).toEqual([at.toString(), 'month']);
    });

    it('refuses another owner’s capability and one nobody registered (Hassan, PR 1354)', async () => {
      const { report } = setUp();
      await expect(report.costByDay(market, 'beta.write', day, day)).rejects.toThrow(
        'has no AI capability',
      );
      await expect(report.markCapReached(market, 'beta.write', day, 'day', at)).rejects.toThrow(
        'has no AI capability',
      );
      await expect(report.lastCapReached(market, 'alpha.chatt')).rejects.toThrow(
        'has no AI capability',
      );
      await expect(
        report.capReached(testCallContext(market, 'system'), 'beta.write'),
      ).rejects.toThrow('has no AI capability');
    });

    it('answers the gateway’s cap answer for its own capability only (G4d2)', async () => {
      const { report } = setUp();
      asked.length = 0;
      await expect(
        report.capReached(testCallContext(market, 'system'), 'alpha.chat'),
      ).resolves.toBe('month');
      expect(asked).toEqual(['alpha.chat']);
    });

    it('refuses a cap-reached record for a day after the Market day of its instant', async () => {
      const { report, store } = setUp();
      await expect(
        report.markCapReached(market, 'alpha.chat', day.add({ days: 2 }), 'day', at),
      ).rejects.toThrow('A cap cannot be reached on');
      expect(store.capReached.size).toBe(0);
    });
  });
});
