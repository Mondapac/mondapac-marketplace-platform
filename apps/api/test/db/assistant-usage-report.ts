import { randomBytes } from 'node:crypto';
import { uuidV7 } from '@mondapac/shared-kernel';
import type { Id, IdGenerator, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { Client } from 'pg';
import type { AssistantRuntime } from '../../src/modules/assistant/application/ports/assistant-runtime';
import {
  ASSISTANT_AI_CAPABILITIES,
  BUYER_CHAT,
} from '../../src/modules/assistant/contracts/ai-capabilities';
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

/**
 * What the gateway's settle writes for one buyer-chat call, as the database tests need it: the
 * call's cost added to the buyer chat's day row and day counter (AI Gateway G7b reads the spend
 * from the counter).
 */
export async function settleBuyerChat(
  client: Client,
  market: MarketContext,
  day: Temporal.PlainDate,
  costMicroUsd: number,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.ai_usage_days (id, market_id, tenant_id, day, capability, seller_id,
       calls, cost_micro_usd)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, NULL, 1, $5)
     ON CONFLICT (market_id, day, capability, seller_id) DO UPDATE SET
       calls = ai_usage_days.calls + 1,
       cost_micro_usd = ai_usage_days.cost_micro_usd + EXCLUDED.cost_micro_usd`,
    [market.marketId, market.tenantId, day.toString(), BUYER_CHAT, costMicroUsd],
  );
  // The capability's day counter, which the assistant's spend is read from (Hassan, PR 1356).
  await client.query(
    `INSERT INTO platform.ai_budget_counters (market_id, tenant_id, period, period_start, scope,
       scope_key, held_micro_usd, spent_micro_usd)
     VALUES ($1, $2, 'day', $3, 'capability', $4, $5, $5)
     ON CONFLICT (market_id, period_start, period, scope, scope_key) DO UPDATE SET
       held_micro_usd = ai_budget_counters.held_micro_usd + EXCLUDED.held_micro_usd,
       spent_micro_usd = ai_budget_counters.spent_micro_usd + EXCLUDED.spent_micro_usd`,
    [market.marketId, market.tenantId, day.toString(), BUYER_CHAT, costMicroUsd],
  );
}

/**
 * A runtime that settles each answer's cost in the gateway's day row before it answers, as
 * `GatewayAssistantRuntime` does through the gateway (the cost is settled inside `run`).
 */
export function settlingRuntime(
  runtime: AssistantRuntime,
  client: Client,
  dayOf: (market: MarketContext) => Temporal.PlainDate,
): AssistantRuntime {
  return {
    apiKeyConfigured: (marketId) => runtime.apiKeyConfigured(marketId),
    available: (context) => runtime.available(context),
    complete: async (context, request, timeoutMs, turnId) => {
      const answer = await runtime.complete(context, request, timeoutMs, turnId);
      if (answer.costMicroUsd > 0) {
        await settleBuyerChat(client, context.market, dayOf(context.market), answer.costMicroUsd);
      }
      return answer;
    },
  };
}
