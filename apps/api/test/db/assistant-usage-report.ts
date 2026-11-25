import { randomBytes } from 'node:crypto';
import { uuidV7 } from '@mondapac/shared-kernel';
import type { Id, IdGenerator } from '@mondapac/shared-kernel';
import { ASSISTANT_AI_CAPABILITIES } from '../../src/modules/assistant/contracts/ai-capabilities';
import { CapabilityRegistry } from '../../src/platform/ai/capability-registry';
import {
  AiUsageReport,
  type CapabilityUsageReport,
} from '../../src/platform/ai/usage/ai-usage-report';
import { PrismaAiUsageStore } from '../../src/platform/persistence/ai-usage/prisma-ai-usage-store';
import type { PrismaService } from '../../src/platform/persistence/prisma.service';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../support/test-config';

const ids: IdGenerator = {
  next: <K extends string>() => uuidV7(Date.now(), randomBytes(10)) as Id<K>,
};

/**
 * The gateway's usage report on the real store, with the assistant's capabilities registered, for
 * the assistant's database tests (AI Gateway G7).
 */
export function assistantUsageReport(prisma: PrismaService): CapabilityUsageReport {
  const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
  const registry = new CapabilityRegistry();
  registry.register('assistant', ASSISTANT_AI_CAPABILITIES);
  return new AiUsageReport(new PrismaAiUsageStore(prisma, ids), registry, markets).for('assistant');
}
