import { Logger } from '@nestjs/common';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { AppConfig } from '../../../platform/config/app-config';
import { AiGateway } from '../../../platform/ai/ai-gateway';
import { CapabilityRegistry } from '../../../platform/ai/capability-registry';
import { ModelGateway } from '../../../platform/ai/model-gateway';
import type { ModelProvider, ModelRequest, ModelTurn } from '../../../platform/ai/model-provider';
import { MASKED } from '../../../platform/ai/personal-data-masker';
import { CATALOG_AI_CAPABILITIES } from '../contracts/ai-capabilities';
import { guardDraft } from '../domain/description-writer/draft-guard';
import { GatewayDescriptionWriterModel } from './gateway-description-writer-model';

const AU = testMarketContext('AU', 'default');
const ZZ = testMarketContext('ZZ', 'default');
const SELLER = '01938a2b-4123-7456-8abc-0123456789ab' as Id<'Seller'>;
const TURN: ModelTurn = {
  blocks: [{ type: 'text', text: 'A sturdy pan.' }],
  stop: 'end',
  usage: { inputTokens: 10, outputTokens: 5 },
};
const REQUEST = { system: 'You write.', input: 'Pan, call 0412 345 678', maxOutputTokens: 5000 };
const PRICE = { inputPicoUsd: 1_000_000, outputPicoUsd: 5_000_000 };

const configOf = () =>
  ({
    aiKillSwitch: false,
    assistantModels: {
      apiKeys: { AU: 'sk-test-canary-key-0001', ZZ: 'sk-test-canary-key-0002' },
      models: { fast: { AU: 'model-fast', ZZ: 'model-fast' }, balanced: {} },
      prices: { fast: { AU: PRICE, ZZ: PRICE }, balanced: {} },
    },
  }) as unknown as AppConfig;

function sellerContext(market = AU): CallContext {
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: '01938a2b-4123-7456-8abc-00000000000a' as Id<'Account'>,
      sessionId: '01938a2b-4123-7456-8abc-00000000000b' as Id<'Session'>,
      sellerId: SELLER,
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

describe('GatewayDescriptionWriterModel on the real AiGateway (AIS-03; ADR-0019 R8)', () => {
  let requests: ModelRequest[];
  let sellerOn: boolean;

  const modelOf = () => {
    const registry = new CapabilityRegistry();
    registry.register('catalog', CATALOG_AI_CAPABILITIES);
    registry.seal();
    const provider: ModelProvider = {
      call: (_credentials, request) => {
        requests.push(request);
        return Promise.resolve(TURN);
      },
    };
    const gateway = new AiGateway(new ModelGateway(configOf(), provider), registry, {
      isOn: () => Promise.resolve(sellerOn),
    });
    return new GatewayDescriptionWriterModel(gateway);
  };

  beforeEach(() => {
    requests = [];
    sellerOn = true;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['AU', AU],
    ['ZZ', ZZ],
  ])('writes for a seller with the switch on, masked and capped (%s)', async (_name, market) => {
    const model = modelOf();
    const audience = { kind: 'seller', sellerId: SELLER } as const;
    expect(await model.available(sellerContext(market), audience, 'fast')).toBe(true);
    expect(await model.write(sellerContext(market), audience, 'fast', REQUEST, 60_000)).toEqual({
      ok: true,
      text: 'A sturdy pan.',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.maxOutputTokens).toBe(700);
    expect(requests[0]!.messages[0]!.blocks[0]).toEqual({
      type: 'text',
      text: `Pan, call ${MASKED}`,
    });
  });

  it("is not available and calls nothing when the seller's switch is off", async () => {
    sellerOn = false;
    const model = modelOf();
    const audience = { kind: 'seller', sellerId: SELLER } as const;
    expect(await model.available(sellerContext(), audience, 'fast')).toBe(false);
    expect(await model.write(sellerContext(), audience, 'fast', REQUEST, 1000)).toEqual({
      ok: false,
      failure: 'not-configured',
    });
    expect(requests).toHaveLength(0);
  });

  it('keeps the audiences apart: a seller cannot use the admin writer, nor an admin the seller one', async () => {
    const model = modelOf();
    expect(await model.available(sellerContext(), { kind: 'admin' }, 'fast')).toBe(false);
    expect(
      await model.available(adminContext(), { kind: 'seller', sellerId: SELLER }, 'fast'),
    ).toBe(false);
    expect(await model.available(adminContext(), { kind: 'admin' }, 'fast')).toBe(true);
  });

  it("drops a draft sentence that echoes the gateway's mask", () => {
    const draft = guardDraft(`A sturdy pan. Call ${MASKED} to ask.`, 'pan');
    expect(draft.sentences.map((s) => s.text)).toEqual(['A sturdy pan.']);
    expect(draft.leftOut).toEqual({ certification: 0, other: 1 });
  });
});
