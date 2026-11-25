import { Temporal } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { CapabilityRegistry } from '../capability-registry';
import type { CapabilitySpec } from '../capability';
import { InMemoryAiUsageStore } from '../../../../test/support/in-memory-ai-usage';
import { PLATFORM_TENANT_ID } from '../../market-context/tenant';
import { MarketRegistry } from '../../market-config/market-registry';
import { loadMarketConfigs } from '../../market-config/market-config';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
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

  function setUp() {
    const registry = new CapabilityRegistry();
    registry.register('alpha', [SPEC]);
    registry.register('beta', [{ ...SPEC, id: 'beta.write', task: 'write' }]);
    const store = new InMemoryAiUsageStore();
    const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
    return { store, report: new AiUsageReport(store, registry, markets).for('alpha') };
  }

  describe.each(['AU', 'ZZ'])('Market %s', (code) => {
    const market = testMarketContext(code, PLATFORM_TENANT_ID);

    it('sums a capability’s settled cost per day, its own only, within the range', async () => {
      const { store, report } = setUp();
      const row = (on: string, capability: string, cost: number, sellerId: string | null = null) =>
        store.usage.push({
          day: Temporal.PlainDate.from(on),
          capability,
          sellerId,
          calls: 1,
          failures: 0,
          fallbacks: 0,
          refusals: 0,
          inputTokens: 1,
          outputTokens: 1,
          costMicroUsd: cost,
          latencyMs: 10,
        });
      row('2026-11-24', 'alpha.chat', 100);
      row('2026-11-25', 'alpha.chat', 200);
      row('2026-11-25', 'alpha.chat', 50, '0190c7a1-0000-7000-8000-000000000001');
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
