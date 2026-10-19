import { Logger } from '@nestjs/common';
import type { MarketId } from '@mondapac/shared-kernel';
import type { AppConfig } from '../config/app-config';
import { AnthropicMessagesProvider, type Fetch } from './anthropic-messages.provider';
import { ModelGateway } from './model-gateway';
import type { ModelProvider, ModelRequest, ModelTurn } from './model-provider';

const AU = 'AU' as MarketId;
const ZZ = 'ZZ' as MarketId;
const KEY = 'sk-test-canary-key-0001';
const PRICE = { inputPicoUsd: 1_000_000, outputPicoUsd: 5_000_000 };
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
  prices: { fast: { AU: PRICE }, balanced: {} },
} as unknown as AppConfig['assistantModels']);

class ScriptedProvider implements ModelProvider {
  readonly calls: { apiKey: string; model: string }[] = [];
  constructor(private readonly answer: (signal: AbortSignal) => Promise<ModelTurn>) {}
  call(credentials: { apiKey: string; model: string }, _r: ModelRequest, signal: AbortSignal) {
    this.calls.push(credentials);
    return this.answer(signal);
  }
}

describe('ModelGateway (ADR-0019 R7, R8)', () => {
  let warnings: unknown[];
  beforeEach(() => {
    warnings = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(message);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('is configured per Market and tier only when key, model and price are all set', () => {
    const gateway = new ModelGateway(AU_ONLY, new ScriptedProvider(() => Promise.resolve(TURN)));
    expect(gateway.keyConfigured(AU)).toBe(true);
    expect(gateway.keyConfigured(ZZ)).toBe(false);
    expect(gateway.configured(AU, 'fast')).toBe(true);
    expect(gateway.configured(AU, 'balanced')).toBe(false);
    expect(gateway.configured(ZZ, 'fast')).toBe(false);
    expect(gateway.modelOf(ZZ, 'fast')).toBeNull();
  });

  it('calls nothing for a Market that is not configured (fail closed)', async () => {
    const provider = new ScriptedProvider(() => Promise.resolve(TURN));
    const gateway = new ModelGateway(AU_ONLY, provider);
    await expect(gateway.complete(ZZ, 'fast', REQUEST, 1000)).resolves.toEqual({
      ok: false,
      failure: 'not-configured',
    });
    await expect(gateway.complete(AU, 'balanced', REQUEST, 1000)).resolves.toEqual({
      ok: false,
      failure: 'not-configured',
    });
    expect(provider.calls).toEqual([]);
  });

  it("passes the Market's own key and model, and answers the turn with its price", async () => {
    const provider = new ScriptedProvider(() => Promise.resolve(TURN));
    const gateway = new ModelGateway(AU_ONLY, provider);
    await expect(gateway.complete(AU, 'fast', REQUEST, 1000)).resolves.toEqual({
      ok: true,
      turn: TURN,
      price: PRICE,
    });
    expect(provider.calls).toEqual([{ apiKey: KEY, model: 'model-fast' }]);
  });

  it('cuts a slow provider at the timeout, even one that ignores the signal', async () => {
    let aborted = false;
    const gateway = new ModelGateway(
      AU_ONLY,
      new ScriptedProvider((signal) => {
        signal.addEventListener('abort', () => (aborted = true));
        return new Promise<ModelTurn>(() => undefined);
      }),
    );
    await expect(gateway.complete(AU, 'fast', REQUEST, 20)).resolves.toEqual({
      ok: false,
      failure: 'timeout',
    });
    expect(aborted).toBe(true);
    expect(warnings).toEqual([
      { msg: 'ai.model-call.failed', marketId: AU, tier: 'fast', failure: 'timeout' },
    ]);
  });

  it('turns any provider failure into unavailable and logs no provider text or key', async () => {
    const gateway = new ModelGateway(
      AU_ONLY,
      new ScriptedProvider(() => Promise.reject(new Error(`bad key ${KEY} for "hi"`))),
    );
    await expect(gateway.complete(AU, 'fast', REQUEST, 1000)).resolves.toEqual({
      ok: false,
      failure: 'unavailable',
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
    const turn = await provider.call({ apiKey: KEY, model: 'model-fast' }, REQUEST, signal);

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
      { apiKey: KEY, model: 'm' },
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

  it('throws on any other status without reading or repeating the provider body', async () => {
    const { provider } = answering(401, { error: { message: `invalid x-api-key ${KEY}` } });
    const failure = await provider
      .call({ apiKey: KEY, model: 'm' }, REQUEST, signal)
      .catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('model provider answered 401');
  });

  it('throws on an answer without content, and maps an unknown stop to other', async () => {
    await expect(
      answering(200, { stop_reason: 'end_turn' }).provider.call(
        { apiKey: KEY, model: 'm' },
        REQUEST,
        signal,
      ),
    ).rejects.toThrow('model provider answer has no content');
    const odd = await answering(200, { content: [], stop_reason: 'pause_turn' }).provider.call(
      { apiKey: KEY, model: 'm' },
      REQUEST,
      signal,
    );
    expect(odd).toEqual({ blocks: [], stop: 'other', usage: { inputTokens: 0, outputTokens: 0 } });
  });
});
