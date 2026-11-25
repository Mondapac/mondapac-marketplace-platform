import { Logger } from '@nestjs/common';
import type { MarketId } from '@mondapac/shared-kernel';
import { testRoute, testRouteCatalogue } from '../../../test/support/ai-routes';
import type { AppConfig } from '../config/app-config';
import { AnthropicMessagesProvider, type Fetch } from './anthropic-messages.provider';
import { checkedInCatalogue } from './catalogue';
import { ModelGateway } from './model-gateway';
import {
  ModelProviderError,
  type ModelCredentials,
  type ModelProvider,
  type ModelRequest,
  type ModelTurn,
} from './model-provider';

const AU = 'AU' as MarketId;
const ZZ = 'ZZ' as MarketId;
const KEY = 'sk-test-canary-key-0001';
const BEDROCK_KEY = 'bedrock-test-canary-key-0001';
const FAST = testRoute('model-fast');
const FAST_BEDROCK = testRoute('model-fast', 'bedrock-mantle');
const REQUEST: ModelRequest = {
  system: 'You help buyers.',
  messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'list_categories', description: 'Categories', inputSchema: { type: 'object' } }],
  maxOutputTokens: 600,
};
const TURN: ModelTurn = {
  blocks: [{ type: 'text', text: 'Hello' }],
  stop: 'end',
  usage: { inputTokens: 10, outputTokens: 2 },
};

const configOf = (models: AppConfig['assistantModels']) =>
  ({ assistantModels: models }) as unknown as AppConfig;
const AU_ONLY = configOf({
  apiKeys: { AU: KEY },
  models: { fast: { AU: 'model-fast' }, balanced: { AU: 'model-balanced' } },
  bedrockApiKeys: { AU: BEDROCK_KEY },
});
const gatewayOf = (provider: ModelProvider, config = AU_ONLY) =>
  new ModelGateway(config, provider, testRouteCatalogue());

class ScriptedProvider implements ModelProvider {
  readonly calls: ModelCredentials[] = [];
  constructor(private readonly answer: (signal: AbortSignal) => Promise<ModelTurn>) {}
  call(credentials: ModelCredentials, _r: ModelRequest, signal: AbortSignal) {
    this.calls.push(credentials);
    return this.answer(signal);
  }
}

describe('ModelGateway (ADR-0019 R7, R8; ADR-0052)', () => {
  let warnings: unknown[];
  beforeEach(() => {
    warnings = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(message);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('calls nothing while AI_KILL_SWITCH is set (ADR-0026 decision 8)', async () => {
    const provider = new ScriptedProvider(() => Promise.resolve(TURN));
    const killed = { ...AU_ONLY, aiKillSwitch: true } as unknown as AppConfig;
    const gateway = gatewayOf(provider, killed);
    expect(gateway.killSwitchSet()).toBe(true);
    await expect(gateway.complete(AU, FAST, REQUEST, 1000)).resolves.toEqual({
      ok: false,
      failure: 'not-configured',
    });
    expect(provider.calls).toHaveLength(0);
    expect(warnings).toContainEqual(expect.objectContaining({ msg: 'ai.kill-switch.set' }));
  });

  it('knows each route key and tier model per Market', () => {
    const gateway = gatewayOf(new ScriptedProvider(() => Promise.resolve(TURN)));
    expect(gateway.keyConfigured(AU)).toBe(true);
    expect(gateway.keyConfigured(ZZ)).toBe(false);
    expect(gateway.routeKeyConfigured(AU, 'bedrock-mantle')).toBe(true);
    expect(gateway.routeKeyConfigured(ZZ, 'bedrock-mantle')).toBe(false);
    expect(gateway.modelOf(AU, 'fast')).toBe('model-fast');
    expect(gateway.modelOf(ZZ, 'fast')).toBeNull();
  });

  it('reads a tier given as an exact model id as its family', () => {
    const gateway = new ModelGateway(
      configOf({
        apiKeys: {},
        models: { fast: { AU: 'anthropic.model-fast' }, balanced: {} },
        bedrockApiKeys: {},
      }),
      new ScriptedProvider(() => Promise.resolve(TURN)),
      testRouteCatalogue(),
    );
    expect(gateway.modelOf(AU, 'fast')).toBe('model-fast');
  });

  it('logs a tier naming a model outside the catalogue and keeps that tier off, booting (R7, R8)', () => {
    const errors: unknown[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      errors.push(message);
    });
    const gateway = new ModelGateway(
      configOf({
        apiKeys: {},
        models: { fast: { AU: 'some-preview-model' }, balanced: {} },
        bedrockApiKeys: {},
      }),
      new ScriptedProvider(() => Promise.resolve(TURN)),
      checkedInCatalogue(),
    );
    expect(gateway.modelOf(AU, 'fast')).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ msg: 'ai.model.unknown' });
    expect(JSON.stringify(errors[0])).toMatch(
      /ASSISTANT_MODEL_FAST: AU names a model that is not in the/,
    );
    expect(JSON.stringify(errors)).not.toContain('some-preview-model');
  });

  it('calls nothing for a Market without the route key (fail closed)', async () => {
    const provider = new ScriptedProvider(() => Promise.resolve(TURN));
    const gateway = gatewayOf(provider);
    await expect(gateway.complete(ZZ, FAST, REQUEST, 1000)).resolves.toEqual({
      ok: false,
      failure: 'not-configured',
    });
    expect(provider.calls).toEqual([]);
  });

  it("passes the route's own key, model and region", async () => {
    const provider = new ScriptedProvider(() => Promise.resolve(TURN));
    const gateway = gatewayOf(provider);
    await expect(gateway.complete(AU, FAST, REQUEST, 1000)).resolves.toEqual({
      ok: true,
      turn: TURN,
    });
    await gateway.complete(AU, FAST_BEDROCK, REQUEST, 1000);
    expect(provider.calls).toEqual([
      { apiKey: KEY, model: 'model-fast', route: 'anthropic-api', region: 'ap-southeast-2' },
      {
        apiKey: BEDROCK_KEY,
        model: 'anthropic.model-fast',
        route: 'bedrock-mantle',
        region: 'ap-southeast-2',
      },
    ]);
  });

  it('cuts a slow provider at the timeout, even one that ignores the signal', async () => {
    let aborted = false;
    const gateway = gatewayOf(
      new ScriptedProvider((signal) => {
        signal.addEventListener('abort', () => (aborted = true));
        return new Promise<ModelTurn>(() => undefined);
      }),
    );
    await expect(gateway.complete(AU, FAST, REQUEST, 20)).resolves.toEqual({
      ok: false,
      failure: 'timeout',
    });
    expect(aborted).toBe(true);
    // The AI Gateway logs a failed call once, with its capability; this layer does not.
    expect(warnings).toEqual([]);
  });

  it.each([
    [new ModelProviderError('rate-limited'), 'rate-limited'],
    [new ModelProviderError('server'), 'unavailable'],
    [new ModelProviderError('network'), 'unavailable'],
    [new ModelProviderError('route'), 'unavailable'],
    [new ModelProviderError('client'), 'rejected'],
    [new Error(`bad key ${KEY} for "hi"`), 'unavailable'],
  ])('turns %s into %s and logs no provider text or key', async (error, failure) => {
    const gateway = gatewayOf(new ScriptedProvider(() => Promise.reject(error)));
    await expect(gateway.complete(AU, FAST, REQUEST, 1000)).resolves.toEqual({
      ok: false,
      failure,
    });
    expect(JSON.stringify(warnings)).not.toContain(KEY);
    expect(JSON.stringify(warnings)).not.toContain('hi');
  });
});

describe('AnthropicMessagesProvider', () => {
  const signal = new AbortController().signal;
  const answering = (status: number, body: unknown) => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetchFn: Fetch = (url, init) => {
      sent.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    };
    return { sent, provider: new AnthropicMessagesProvider(fetchFn) };
  };

  it('sends the request with the key in a header only, the fixed instructions cached', async () => {
    const { sent, provider } = answering(200, {
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 3 },
    });
    const turn = await provider.call(
      { apiKey: KEY, model: 'model-fast', route: 'anthropic-api', region: null },
      REQUEST,
      signal,
    );

    expect(turn).toEqual({
      blocks: [{ type: 'text', text: 'Hello' }],
      stop: 'end',
      usage: { inputTokens: 105, outputTokens: 3 },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect((sent[0]!.init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    expect(sent[0]!.init.body).not.toContain(KEY);
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({
      model: 'model-fast',
      max_tokens: 600,
      system: [{ type: 'text', text: 'You help buyers.', cache_control: { type: 'ephemeral' } }],
      tools: [
        { name: 'list_categories', description: 'Categories', input_schema: { type: 'object' } },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
  });

  it('maps tool calls and results both ways, and drops blocks it does not know', async () => {
    const { sent, provider } = answering(200, {
      content: [
        { type: 'thinking', thinking: 'secret' },
        { type: 'tool_use', id: 't1', name: 'list_categories', input: {} },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const turn = await provider.call(
      { apiKey: KEY, model: 'm', route: 'anthropic-api', region: null },
      {
        ...REQUEST,
        messages: [
          ...REQUEST.messages,
          { role: 'assistant', blocks: [{ type: 'tool-call', id: 't0', name: 'x', input: {} }] },
          {
            role: 'user',
            blocks: [{ type: 'tool-result', callId: 't0', content: '{}', isError: true }],
          },
        ],
      },
      signal,
    );

    expect(turn.blocks).toEqual([
      { type: 'tool-call', id: 't1', name: 'list_categories', input: {} },
    ]);
    expect(turn.stop).toBe('tool-use');
    const body = JSON.parse(sent[0]!.init.body as string) as { messages: unknown[] };
    expect(body.messages.slice(1)).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'x', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't0', content: '{}', is_error: true }],
      },
    ]);
  });

  it.each([
    [400, 'client'],
    [413, 'client'],
    [422, 'client'],
    [401, 'route'],
    [403, 'route'],
    [404, 'route'],
    [429, 'rate-limited'],
    [500, 'server'],
    [529, 'server'],
  ])(
    'throws the kind of a %s answer without reading or repeating the provider body',
    async (status, kind) => {
      const { provider } = answering(status, { error: { message: `invalid x-api-key ${KEY}` } });
      const failure = await provider
        .call({ apiKey: KEY, model: 'm', route: 'anthropic-api', region: null }, REQUEST, signal)
        .catch((e: Error) => e);
      expect(failure).toBeInstanceOf(ModelProviderError);
      expect((failure as ModelProviderError).kind).toBe(kind);
      expect((failure as Error).message).not.toContain(KEY);
    },
  );

  it('never follows a redirect (the key and the data would go to another host)', async () => {
    const { sent, provider } = answering(200, {
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    await provider.call(
      { apiKey: KEY, model: 'm', route: 'anthropic-api', region: null },
      REQUEST,
      signal,
    );
    expect(sent[0]!.init.redirect).toBe('error');
  });

  it('throws network when the request does not reach the provider', async () => {
    const provider = new AnthropicMessagesProvider(() => Promise.reject(new Error('ECONNRESET')));
    const failure = await provider
      .call({ apiKey: KEY, model: 'm', route: 'anthropic-api', region: null }, REQUEST, signal)
      .catch((e: Error) => e);
    expect((failure as ModelProviderError).kind).toBe('network');
  });

  it("calls Bedrock's Messages endpoint in the row's region with the key as a bearer token", async () => {
    const { sent, provider } = answering(200, {
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    await provider.call(
      {
        apiKey: BEDROCK_KEY,
        model: 'anthropic.model-fast',
        route: 'bedrock-mantle',
        region: 'ap-southeast-2',
      },
      REQUEST,
      signal,
    );
    expect(sent[0]!.url).toBe(
      'https://bedrock-mantle.ap-southeast-2.api.aws/anthropic/v1/messages',
    );
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${BEDROCK_KEY}`);
    expect(headers['x-api-key']).toBeUndefined();
    expect(sent[0]!.init.body).not.toContain(BEDROCK_KEY);
    expect(JSON.parse(sent[0]!.init.body as string)).toMatchObject({
      model: 'anthropic.model-fast',
    });
  });

  it.each([null, 'ap-southeast-2.evil.example/x', 'AP-SOUTHEAST-2'])(
    'refuses a Bedrock call with region %s, reaching no host',
    async (region) => {
      const { sent, provider } = answering(200, {});
      const failure = await provider
        .call({ apiKey: BEDROCK_KEY, model: 'm', route: 'bedrock-mantle', region }, REQUEST, signal)
        .catch((e: Error) => e);
      expect((failure as ModelProviderError).kind).toBe('client');
      expect(sent).toEqual([]);
    },
  );

  it('refuses an unknown route, reaching no host', async () => {
    const { sent, provider } = answering(200, {});
    await expect(
      provider.call({ apiKey: KEY, model: 'm', route: 'elsewhere', region: null }, REQUEST, signal),
    ).rejects.toBeInstanceOf(ModelProviderError);
    expect(sent).toEqual([]);
  });

  it('throws on an answer without content, and maps an unknown stop to other', async () => {
    await expect(
      answering(200, { stop_reason: 'end_turn' }).provider.call(
        { apiKey: KEY, model: 'm', route: 'anthropic-api', region: null },
        REQUEST,
        signal,
      ),
    ).rejects.toBeInstanceOf(ModelProviderError);
    const odd = await answering(200, { content: [], stop_reason: 'pause_turn' }).provider.call(
      { apiKey: KEY, model: 'm', route: 'anthropic-api', region: null },
      REQUEST,
      signal,
    );
    expect(odd).toEqual({ blocks: [], stop: 'other', usage: { inputTokens: 0, outputTokens: 0 } });
  });
});
