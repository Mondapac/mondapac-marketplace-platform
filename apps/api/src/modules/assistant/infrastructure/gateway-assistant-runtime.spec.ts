import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { AiGateway, GatewayRun, GatewayStatus } from '../../../platform/ai/ai-gateway';
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
  const runtimeOf = (
    run: GatewayRun,
    calls: unknown[] = [],
    status: GatewayStatus = { on: false, reason: 'kill-switch' },
  ) =>
    new GatewayAssistantRuntime({
      run: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(run);
      },
      status: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(status);
      },
      setup: () => ({ killSwitch: false, keyConfigured: true }),
    } as unknown as AiGateway);

  it('runs the buyer chat with its timeout and turn, no model tier, and passes the price on', async () => {
    const calls: unknown[] = [];
    const runtime = runtimeOf(
      {
        ok: true,
        turn: TURN,
        route: { provider: 'p', model: 'm', route: 'r', attempt: 1 },
        costMicroUsd: 7,
      },
      calls,
    );
    expect(await runtime.complete(context, REQUEST, 500, 'turn-1')).toEqual({
      ok: true,
      turn: TURN,
      costMicroUsd: 7,
    });
    expect(calls).toEqual([[BUYER_CHAT, context, REQUEST, { timeoutMs: 500, turnId: 'turn-1' }]]);
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
    expect(await runtime.complete(context, REQUEST, 500, 'turn-1')).toEqual({
      ok: false,
      failure,
      costMicroUsd: cost,
    });
  });

  it('is unavailable when the gateway says off (no route without a chat list), and reads the key status only', async () => {
    const calls: unknown[] = [];
    const runtime = runtimeOf({ ok: false, reason: 'off', costMicroUsd: 0 }, calls);
    expect(await runtime.availability(context)).toBe('off');
    expect(calls).toEqual([[BUYER_CHAT, context, {}]]);
    expect(runtime.apiKeyConfigured(market.marketId)).toBe(true);
  });

  // G4d2: the chat's caps are the gateway's; a full one is the gateway's cap answer, which the
  // assistant shows as paused. Every other reason the gateway gives is off.
  it.each([
    [{ on: true }, 'on'],
    [{ on: false, reason: 'over-budget' }, 'over-budget'],
    [{ on: false, reason: 'kill-switch' }, 'off'],
    [{ on: false, reason: 'emergency-stop' }, 'off'],
    [{ on: false, reason: 'no-route' }, 'off'],
    [{ on: false, reason: 'off' }, 'off'],
  ] as const)('answers the gateway status %o as %s', async (status, expected) => {
    const runtime = runtimeOf({ ok: false, reason: 'off', costMicroUsd: 0 }, [], status);
    expect(await runtime.availability(context)).toBe(expected);
  });
});
