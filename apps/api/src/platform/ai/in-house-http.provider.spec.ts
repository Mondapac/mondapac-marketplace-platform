import type { Fetch } from './anthropic-messages.provider';
import {
  IN_HOUSE_CONTRACT,
  IN_HOUSE_MAX_ANSWER_BYTES,
  InHouseHttpProvider,
} from './in-house-http.provider';
import {
  ModelProviderError,
  type ModelCredentials,
  type ModelProvider,
  type ModelRequest,
} from './model-provider';
import { RouteProviders } from './route-providers';

const KEY = 'in-house-test-canary-key-0123456789abcdef';
const CREDENTIALS: ModelCredentials = {
  apiKey: KEY,
  model: 'mondapac-intelligence-v1',
  route: 'in-house-http',
  region: 'ap-southeast-2',
  endpoint: 'https://intelligence.example.com/model',
};
const REQUEST: ModelRequest = {
  system: 'You write product descriptions.',
  messages: [
    {
      role: 'user',
      blocks: [{ type: 'text', text: 'Describe dates.' }],
    },
  ],
  tools: [{ name: 'list_categories', description: 'Categories', inputSchema: { type: 'object' } }],
  maxOutputTokens: 400,
};
const OK = {
  contract: IN_HOUSE_CONTRACT,
  model: 'mondapac-intelligence-v1',
  blocks: [{ type: 'text', text: 'Sweet Medjool dates.' }],
  stop: 'end',
  usage: { inputTokens: 42, outputTokens: 7 },
};
const signal = new AbortController().signal;

function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetchFn: Fetch = (url, init) => {
    sent.push({ url, init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve(new Response(text, { status, headers }));
  };
  return { sent, provider: new InHouseHttpProvider(fetchFn) };
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  const failure = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ModelProviderError);
  return (failure as ModelProviderError).kind;
}

describe('the in-house model adapter, contract mondapac-model/1 (ADR-0052 decision 6, G6a)', () => {
  it('posts our message format to the row endpoint, the key in the header only', async () => {
    const { sent, provider } = answering(200, OK);
    const turn = await provider.call(CREDENTIALS, REQUEST, signal);

    expect(turn).toEqual({
      blocks: [{ type: 'text', text: 'Sweet Medjool dates.' }],
      stop: 'end',
      usage: { inputTokens: 42, outputTokens: 7 },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://intelligence.example.com/model/v1/messages');
    expect(sent[0]!.init.method).toBe('POST');
    expect(sent[0]!.init.redirect).toBe('error');
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers['mondapac-contract']).toBe(IN_HOUSE_CONTRACT);
    expect(headers['mondapac-retention']).toBe('none');
    const body = sent[0]!.init.body as string;
    expect(body).not.toContain(KEY);
    expect(JSON.parse(body)).toEqual({
      contract: IN_HOUSE_CONTRACT,
      model: 'mondapac-intelligence-v1',
      system: REQUEST.system,
      messages: [{ role: 'user', blocks: [{ type: 'text', text: 'Describe dates.' }] }],
      tools: [
        { name: 'list_categories', description: 'Categories', inputSchema: { type: 'object' } },
      ],
      maxOutputTokens: 400,
    });
  });

  it('keeps one slash between the endpoint and the contract path', async () => {
    const { sent, provider } = answering(200, OK);
    await provider.call(
      { ...CREDENTIALS, endpoint: 'https://intelligence.example.com/' },
      REQUEST,
      signal,
    );
    expect(sent[0]!.url).toBe('https://intelligence.example.com/v1/messages');
  });

  it('reads a tool call the request offered, with tool-use as its stop', async () => {
    const { provider } = answering(200, {
      ...OK,
      blocks: [{ type: 'tool-call', id: 'c1', name: 'list_categories', input: { q: 'dates' } }],
      stop: 'tool-use',
    });
    const turn = await provider.call(CREDENTIALS, REQUEST, signal);
    expect(turn.blocks).toEqual([
      { type: 'tool-call', id: 'c1', name: 'list_categories', input: { q: 'dates' } },
    ]);
    expect(turn.stop).toBe('tool-use');
  });

  it.each([
    [
      'a tool the request did not offer',
      {
        blocks: [{ type: 'tool-call', id: 'c1', name: 'refund_order', input: {} }],
        stop: 'tool-use',
      },
    ],
    [
      'a tool-result block from the model',
      { blocks: [{ type: 'tool-result', callId: 'c1', content: 'x', isError: false }] },
    ],
    ['an unknown block type', { blocks: [{ type: 'image', url: 'https://x.example.com/a.png' }] }],
    ['a text block without text', { blocks: [{ type: 'text' }] }],
    ['tool-use with no tool call', { stop: 'tool-use' }],
    ['an unknown stop', { stop: 'paused' }],
    ['no token counts', { usage: undefined }],
    ['a negative token count', { usage: { inputTokens: -1, outputTokens: 2 } }],
    ['a fractional token count', { usage: { inputTokens: 1.5, outputTokens: 2 } }],
    ['blocks that are not a list', { blocks: 'Sweet dates' }],
    ['more output tokens than asked for', { usage: { inputTokens: 1, outputTokens: 401 } }],
    [
      'a tool call whose input is not an object',
      {
        blocks: [{ type: 'tool-call', id: 'c1', name: 'list_categories', input: 'x' }],
        stop: 'tool-use',
      },
    ],
    [
      'two tool calls with one id',
      {
        blocks: [
          { type: 'tool-call', id: 'c1', name: 'list_categories', input: {} },
          { type: 'tool-call', id: 'c1', name: 'list_categories', input: {} },
        ],
        stop: 'tool-use',
      },
    ],
  ])('refuses an answer with %s as a server fault, using none of it', async (_name, change) => {
    const { provider } = answering(200, { ...OK, ...change });
    expect(await kindOf(provider.call(CREDENTIALS, REQUEST, signal))).toBe('server');
  });

  it.each([
    ['another contract version', { contract: 'mondapac-model/2' }],
    ['no contract', { contract: undefined }],
    ['another model version than asked for', { model: 'mondapac-intelligence-v2' }],
  ])('treats %s as an outage of the route, so the next route is tried', async (_name, change) => {
    const { provider } = answering(200, { ...OK, ...change });
    expect(await kindOf(provider.call(CREDENTIALS, REQUEST, signal))).toBe('route');
  });

  it('refuses a body that is not JSON or not an object', async () => {
    expect(
      await kindOf(answering(200, 'not json').provider.call(CREDENTIALS, REQUEST, signal)),
    ).toBe('server');
    expect(await kindOf(answering(200, [OK]).provider.call(CREDENTIALS, REQUEST, signal))).toBe(
      'server',
    );
  });

  it('refuses an answer larger than the cap without parsing it', async () => {
    const big = { ...OK, blocks: [{ type: 'text', text: 'x'.repeat(IN_HOUSE_MAX_ANSWER_BYTES) }] };
    expect(await kindOf(answering(200, big).provider.call(CREDENTIALS, REQUEST, signal))).toBe(
      'server',
    );
    const declared = answering(200, OK, {
      'content-length': String(IN_HOUSE_MAX_ANSWER_BYTES + 1),
    });
    expect(await kindOf(declared.provider.call(CREDENTIALS, REQUEST, signal))).toBe('server');
  });

  it('cuts a streamed answer without a length header at the cap and stops reading', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const provider = new InHouseHttpProvider(() =>
      Promise.resolve(new Response(stream, { status: 200 })),
    );
    expect(await kindOf(provider.call(CREDENTIALS, REQUEST, signal))).toBe('server');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(IN_HOUSE_MAX_ANSWER_BYTES / chunk.byteLength + 2);
  });

  it.each([
    ['a length header that is not a number', { 'content-length': 'abc' }],
    ['a compressed answer', { 'content-encoding': 'gzip' }],
  ])('refuses %s as a server fault', async (_name, headers) => {
    expect(
      await kindOf(answering(200, OK, headers).provider.call(CREDENTIALS, REQUEST, signal)),
    ).toBe('server');
  });

  it('asks for an uncompressed answer', async () => {
    const { sent, provider } = answering(200, OK);
    await provider.call(CREDENTIALS, REQUEST, signal);
    expect((sent[0]!.init.headers as Record<string, string>)['accept-encoding']).toBe('identity');
  });

  it('refuses an answer that is not UTF-8', async () => {
    const provider = new InHouseHttpProvider(() =>
      Promise.resolve(new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 })),
    );
    expect(await kindOf(provider.call(CREDENTIALS, REQUEST, signal))).toBe('server');
  });

  it.each([
    [429, 'rate-limited'],
    [500, 'server'],
    [503, 'server'],
    [400, 'client'],
    [413, 'client'],
    [422, 'client'],
    [401, 'route'],
    [403, 'route'],
    [404, 'route'],
  ] as const)('maps an HTTP %i to %s, never reading the body', async (status, kind) => {
    const { provider } = answering(status, { error: `echo ${KEY}` });
    const failure = await provider.call(CREDENTIALS, REQUEST, signal).catch((e: Error) => e);
    expect((failure as ModelProviderError).kind).toBe(kind);
    expect((failure as Error).message).not.toContain(KEY);
  });

  it('turns a failed connection into network, and leaves a cut by the signal to the gateway', async () => {
    const down = new InHouseHttpProvider(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(await kindOf(down.call(CREDENTIALS, REQUEST, signal))).toBe('network');

    const abort = new AbortController();
    abort.abort();
    const cut = new InHouseHttpProvider(() => Promise.reject(new Error('aborted')));
    await expect(cut.call(CREDENTIALS, REQUEST, abort.signal)).rejects.toThrow('aborted');
  });

  it.each([
    ['no endpoint', { endpoint: null }],
    ['an http endpoint', { endpoint: 'http://intelligence.example.com' }],
    ['an IP endpoint', { endpoint: 'https://10.0.0.5/model' }],
    ['an endpoint with a user', { endpoint: 'https://u:p@intelligence.example.com' }],
    [
      'an endpoint with a query',
      { endpoint: 'https://intelligence.example.com/?to=evil.example.com' },
    ],
    ['another route kind', { route: 'anthropic-api' }],
    ['a non-canonical endpoint', { endpoint: 'https:intelligence.example.com' }],
    ['a special-use host', { endpoint: 'https://model.internal' }],
  ])('refuses %s before anything is sent', async (_name, change) => {
    const { sent, provider } = answering(200, OK);
    expect(await kindOf(provider.call({ ...CREDENTIALS, ...change }, REQUEST, signal))).toBe(
      'client',
    );
    expect(sent).toEqual([]);
  });
});

describe('the route dispatch of the model provider (G6a)', () => {
  const recording = (name: string) => {
    const calls: string[] = [];
    const adapter: ModelProvider = {
      call: (credentials) => {
        calls.push(`${name}:${credentials.route}`);
        return Promise.resolve({
          blocks: [],
          stop: 'end',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    };
    return { calls, adapter };
  };

  it('sends each call to the adapter of its route kind', async () => {
    const messages = recording('messages');
    const inHouse = recording('in-house');
    const providers = new RouteProviders({
      'anthropic-api': messages.adapter,
      'bedrock-mantle': messages.adapter,
      'in-house-http': inHouse.adapter,
    });
    await providers.call(
      { ...CREDENTIALS, route: 'anthropic-api', endpoint: null },
      REQUEST,
      signal,
    );
    await providers.call(
      { ...CREDENTIALS, route: 'bedrock-mantle', endpoint: null },
      REQUEST,
      signal,
    );
    await providers.call(CREDENTIALS, REQUEST, signal);
    expect(messages.calls).toEqual(['messages:anthropic-api', 'messages:bedrock-mantle']);
    expect(inHouse.calls).toEqual(['in-house:in-house-http']);
  });

  it('refuses a route without an adapter as client', async () => {
    const providers = new RouteProviders({} as never);
    expect(
      await kindOf(providers.call({ ...CREDENTIALS, route: 'toString' }, REQUEST, signal)),
    ).toBe('client');
  });
});
