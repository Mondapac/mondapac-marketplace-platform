import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { AiGateway, GatewayRun } from '../../../platform/ai/ai-gateway';
import type { ModelRequest, ModelTurn } from '../../../platform/ai/model-provider';
import { BUYER_CHAT } from '../contracts/ai-capabilities';
import { GatewayAssistantRuntime } from './gateway-assistant-runtime';

const TURN: ModelTurn = {
  blocks: [{ type: 'text', text: 'Hi' }],
  stop: 'end',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const REQUEST: ModelRequest = { system: 's', messages: [], tools: [], maxOutputTokens: 10 };

describe.each([
  ['AU', testMarketContext('AU', 'default')],
  ['ZZ', testMarketContext('ZZ', 'default')],
])('GatewayAssistantRuntime (%s)', (_code, market) => {
  const context = testCallContext(market, 'anonymous');
  const runtimeOf = (run: GatewayRun, calls: unknown[] = []) =>
    new GatewayAssistantRuntime({
      run: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(run);
      },
      status: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ on: false, reason: 'kill-switch' });
      },
      setup: () => ({
        killSwitch: false,
        keyConfigured: true,
        models: { fast: 'model-fast', balanced: null },
      }),
    } as unknown as AiGateway);

  it('runs the buyer chat with its tier and timeout, and passes the price on', async () => {
    const calls: unknown[] = [];
    const runtime = runtimeOf(
      { ok: true, turn: TURN, route: { provider: 'p', model: 'm', attempt: 1 }, costMicroUsd: 7 },
      calls,
    );
    expect(await runtime.complete(context, 'fast', REQUEST, 500, 'turn-1')).toEqual({
      ok: true,
      turn: TURN,
      costMicroUsd: 7,
    });
    expect(calls).toEqual([
      [BUYER_CHAT, context, REQUEST, { tier: 'fast', timeoutMs: 500, turnId: 'turn-1' }],
    ]);
  });

  it.each([
    ['off', 'not-configured', 0],
    ['over-budget', 'unavailable', 0],
    ['rate-limited', 'unavailable', 0],
    ['unavailable', 'unavailable', 0],
    ['rejected-output', 'unavailable', 0],
    ['timeout', 'timeout', 900],
  ] as const)('maps %s to %s and keeps the cost', async (reason, failure, cost) => {
    const runtime = runtimeOf({ ok: false, reason, costMicroUsd: cost });
    expect(await runtime.complete(context, 'fast', REQUEST, 500, 'turn-1')).toEqual({
      ok: false,
      failure,
      costMicroUsd: cost,
    });
  });

  it('is unavailable when the gateway says off, and reads the setup without the key', async () => {
    const calls: unknown[] = [];
    const runtime = runtimeOf({ ok: false, reason: 'off', costMicroUsd: 0 }, calls);
    expect(await runtime.available(context, 'balanced')).toBe(false);
    expect(calls).toEqual([[BUYER_CHAT, context, { tier: 'balanced' }]]);
    expect(runtime.apiKeyConfigured(market.marketId)).toBe(true);
    expect(runtime.modelOf(market.marketId, 'fast')).toBe('model-fast');
    expect(runtime.modelOf(market.marketId, 'balanced')).toBeNull();
  });
});
