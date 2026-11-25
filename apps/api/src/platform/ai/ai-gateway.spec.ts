import { Logger } from '@nestjs/common';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { AppConfig } from '../config/app-config';
import { AiGateway } from './ai-gateway';
import type { CapabilitySpec } from './capability';
import { CapabilityRegistry } from './capability-registry';
import { ModelGateway } from './model-gateway';
import type { ModelProvider, ModelRequest, ModelTurn } from './model-provider';
import { MASKED } from './personal-data-masker';
import type { SellerAiSwitch } from './seller-ai-switch';

const AU = testMarketContext('AU', 'default');
const ZZ = testMarketContext('ZZ', 'default');
const SELLER = '01938a2b-4123-7456-8abc-0123456789ab' as Id<'Seller'>;
const OTHER_SELLER = '01938a2b-4123-7456-8abc-0123456789ac' as Id<'Seller'>;
const PRICE = { inputPicoUsd: 1_000_000, outputPicoUsd: 5_000_000 };
const TURN: ModelTurn = {
  blocks: [{ type: 'text', text: 'Hello' }],
  stop: 'end',
  usage: { inputTokens: 100, outputTokens: 20 },
};
const REQUEST: ModelRequest = {
  system: 'You write.',
  messages: [{ role: 'user', blocks: [{ type: 'text', text: 'Write for me, a@b.co' }] }],
  tools: [],
  maxOutputTokens: 5000,
};

const base = {
  task: 'write',
  maxInputTokens: 4000,
  maxOutputTokens: 500,
  maxToolRounds: 0,
  timeoutMs: 1000,
  promptVersion: 'p-1',
} as const;
const SPECS: CapabilitySpec[] = [
  { id: 'alpha.seller-writer', audience: 'seller', sellerScoped: true, ...base },
  { id: 'alpha.admin-writer', audience: 'admin', sellerScoped: false, ...base },
  { id: 'alpha.buyer-chat', audience: 'buyer', sellerScoped: false, ...base, task: 'chat' },
];

// Only AU is configured, on the fast tier: ZZ is a second Market with no model (both fixtures).
const configOf = (killed = false) =>
  ({
    aiKillSwitch: killed,
    assistantModels: {
      apiKeys: { AU: 'sk-test-canary-key-0001' },
      models: { fast: { AU: 'model-fast' }, balanced: {} },
      prices: { fast: { AU: PRICE }, balanced: {} },
    },
  }) as unknown as AppConfig;

class RecordingProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  answer: (signal: AbortSignal) => Promise<ModelTurn> = () => Promise.resolve(TURN);
  call(_credentials: unknown, request: ModelRequest, signal: AbortSignal) {
    this.requests.push(request);
    return this.answer(signal);
  }
}

function sellerContext(market = AU, sellerId: Id<'Seller'> = SELLER): CallContext {
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: '01938a2b-4123-7456-8abc-00000000000a' as Id<'Account'>,
      sessionId: '01938a2b-4123-7456-8abc-00000000000b' as Id<'Session'>,
      sellerId,
    }),
  );
}

function adminContext(market = AU): CallContext {
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: '01938a2b-4123-7456-8abc-00000000000c' as Id<'Account'>,
      sessionId: '01938a2b-4123-7456-8abc-00000000000d' as Id<'Session'>,
      sellerId: null,
    }),
  );
}

describe('AiGateway (platform-ai.md sections 4 and 5; ADR-0019 decision 7, R3, R8)', () => {
  let provider: RecordingProvider;
  let switchedOn: Set<string>;
  let switchThrows: boolean;

  const gatewayOf = (killed = false) => {
    const registry = new CapabilityRegistry();
    registry.register('alpha', SPECS);
    registry.seal();
    const sellerSwitch: SellerAiSwitch = {
      isOn: (_context, sellerId) =>
        switchThrows
          ? Promise.reject(new Error('down'))
          : Promise.resolve(switchedOn.has(sellerId)),
    };
    return new AiGateway(new ModelGateway(configOf(killed), provider), registry, sellerSwitch);
  };

  beforeEach(() => {
    provider = new RecordingProvider();
    switchedOn = new Set([SELLER]);
    switchThrows = false;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs a seller capability for the seller, masked, with its caps', async () => {
    const run = await gatewayOf().run('alpha.seller-writer', sellerContext(), REQUEST, {
      tier: 'fast',
      sellerId: SELLER,
      timeoutMs: 60_000,
    });
    expect(run).toEqual({
      ok: true,
      turn: TURN,
      route: { provider: 'anthropic', model: 'model-fast', attempt: 1 },
      costMicroUsd: 200,
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.maxOutputTokens).toBe(500);
    expect(provider.requests[0]!.messages[0]!.blocks[0]).toEqual({
      type: 'text',
      text: `Write for me, ${MASKED}`,
    });
  });

  it.each([
    ['an unknown capability', 'alpha.nothing', () => sellerContext(), { sellerId: SELLER }],
    ['no seller id', 'alpha.seller-writer', () => sellerContext(), {}],
    [
      'another seller (cross-seller canary)',
      'alpha.seller-writer',
      () => sellerContext(),
      { sellerId: OTHER_SELLER },
    ],
    [
      'an admin calling a seller capability',
      'alpha.seller-writer',
      () => adminContext(),
      { sellerId: SELLER },
    ],
    ['a seller calling an admin capability', 'alpha.admin-writer', () => sellerContext(), {}],
    ['a seller calling the buyer chat', 'alpha.buyer-chat', () => sellerContext(), {}],
  ])('is off for %s and calls nothing', async (_name, capability, context, extra) => {
    const gateway = gatewayOf();
    const options = { tier: 'fast' as const, ...extra };
    expect(await gateway.status(capability, context(), options)).toEqual({
      on: false,
      reason: 'off',
    });
    expect(await gateway.run(capability, context(), REQUEST, options)).toEqual({
      ok: false,
      reason: 'off',
      costMicroUsd: 0,
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('is off in an acting-as session (R3)', async () => {
    const own = sellerContext();
    const actingAs = { ...own, actor: { ...own.actor, actingAs: { adminAccountId: 'x' } } };
    expect(
      await gatewayOf().status('alpha.seller-writer', actingAs as never, {
        tier: 'fast',
        sellerId: SELLER,
      }),
    ).toEqual({ on: false, reason: 'off' });
  });

  it("is off when the seller's switch is off or cannot answer (an error is off)", async () => {
    const gateway = gatewayOf();
    switchedOn.clear();
    const options = { tier: 'fast' as const, sellerId: SELLER };
    expect(await gateway.status('alpha.seller-writer', sellerContext(), options)).toEqual({
      on: false,
      reason: 'off',
    });
    switchedOn.add(SELLER);
    switchThrows = true;
    expect(await gateway.run('alpha.seller-writer', sellerContext(), REQUEST, options)).toEqual({
      ok: false,
      reason: 'off',
      costMicroUsd: 0,
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('reports the kill switch, and a Market or tier without a model as no route', async () => {
    expect(
      await gatewayOf(true).status('alpha.admin-writer', adminContext(), { tier: 'fast' }),
    ).toEqual({ on: false, reason: 'kill-switch' });
    const gateway = gatewayOf();
    expect(
      await gateway.status('alpha.admin-writer', adminContext(), { tier: 'balanced' }),
    ).toEqual({ on: false, reason: 'no-route' });
    expect(await gateway.status('alpha.admin-writer', adminContext(ZZ), { tier: 'fast' })).toEqual({
      on: false,
      reason: 'no-route',
    });
    expect(await gateway.status('alpha.admin-writer', adminContext(), { tier: 'fast' })).toEqual({
      on: true,
    });
  });

  it('lets a guest reach the buyer chat', async () => {
    expect(
      await gatewayOf().status('alpha.buyer-chat', testCallContext(AU, 'anonymous'), {
        tier: 'fast',
      }),
    ).toEqual({ on: true });
  });

  it('cuts a call at the shorter timeout and counts the most it can cost', async () => {
    provider.answer = (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error())),
      );
    const run = await gatewayOf().run('alpha.admin-writer', adminContext(), REQUEST, {
      tier: 'fast',
      timeoutMs: 5,
    });
    expect(run).toMatchObject({ ok: false, reason: 'timeout' });
    expect(run.costMicroUsd).toBeGreaterThan(500 * 5);
  });

  it('turns a provider failure into unavailable at no cost', async () => {
    provider.answer = () => Promise.reject(new Error('provider text with secrets'));
    expect(
      await gatewayOf().run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
    ).toEqual({ ok: false, reason: 'unavailable', costMicroUsd: 0 });
  });

  it('shows the setup without the key', () => {
    expect(gatewayOf().setup(AU.marketId)).toEqual({
      killSwitch: false,
      keyConfigured: true,
      models: { fast: 'model-fast', balanced: null },
    });
    expect(JSON.stringify(gatewayOf().setup(AU.marketId))).not.toContain('sk-test');
  });
});
