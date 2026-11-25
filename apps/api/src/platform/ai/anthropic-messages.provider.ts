import {
  ModelProviderError,
  type ModelBlock,
  type ModelCredentials,
  type ModelProvider,
  type ModelRequest,
  type ModelStop,
  type ModelTurn,
} from './model-provider';

const API_VERSION = '2023-06-01';
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

/**
 * Where a route's Messages API is and how its key is sent. `anthropic-api` is Anthropic's own API
 * (`x-api-key`); `bedrock-mantle` is Amazon Bedrock's Messages API endpoint in the row's region
 * (ADR-0052 decision 5, the fallback route), with a Bedrock API key as a bearer token. The region
 * comes from the checked-in catalogue row and is checked again here, so no other host is reached.
 */
function targetOf(credentials: ModelCredentials): { url: string; auth: Record<string, string> } {
  switch (credentials.route) {
    case 'anthropic-api':
      return {
        url: 'https://api.anthropic.com/v1/messages',
        auth: { 'x-api-key': credentials.apiKey },
      };
    case 'bedrock-mantle': {
      const region = credentials.region;
      if (region === null || !REGION.test(region)) throw new ModelProviderError('client');
      return {
        url: `https://bedrock-mantle.${region}.api.aws/anthropic/v1/messages`,
        auth: { authorization: `Bearer ${credentials.apiKey}` },
      };
    }
    default:
      throw new ModelProviderError('client');
  }
}

/** The kind of a non-200 answer: 429 is a rate limit, 5xx (529 included) a server error. */
function failureOf(status: number): ModelProviderError {
  if (status === 429) return new ModelProviderError('rate-limited');
  if (status >= 500) return new ModelProviderError('server');
  return new ModelProviderError('client');
}

/** The fetch this adapter uses; tests pass their own, so nothing leaves the process. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

type ApiBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean };

const STOPS: Readonly<Record<string, ModelStop>> = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool-use',
  max_tokens: 'max-tokens',
  refusal: 'refusal',
};

function apiBlockOf(block: ModelBlock): ApiBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool-call':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool-result':
      return {
        type: 'tool_result',
        tool_use_id: block.callId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/**
 * The provider adapter for the Anthropic Messages API over plain HTTPS (no SDK, so no provider
 * package enters the dependency tree), on each route that serves it: Anthropic's own API and
 * Amazon Bedrock's Messages API endpoint (same request and answer shape, the model id carries the
 * `anthropic.` prefix in its catalogue row). Non-streaming: the assistant checks a whole answer
 * before the buyer sees any of it. The fixed instructions are marked for prompt caching. Any answer
 * that is not a 200 with the expected shape throws a {@link ModelProviderError}, with no provider
 * text in the error.
 */
export class AnthropicMessagesProvider implements ModelProvider {
  constructor(private readonly fetchFn: Fetch = (url, init) => fetch(url, init)) {}

  async call(
    credentials: ModelCredentials,
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelTurn> {
    const target = targetOf(credentials);
    let response: Response;
    try {
      response = await this.fetchFn(target.url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...target.auth,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: credentials.model,
          max_tokens: request.maxOutputTokens,
          system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.blocks.map(apiBlockOf),
          })),
        }),
      });
    } catch (error) {
      // A cut by the signal is the gateway's timeout; anything else did not reach the provider.
      if (signal.aborted) throw error;
      throw new ModelProviderError('network');
    }
    if (response.status !== 200) {
      // The body is not read: it may echo the request.
      throw failureOf(response.status);
    }
    const body = (await response.json()) as {
      content?: unknown;
      stop_reason?: unknown;
      usage?: Record<string, unknown>;
    };
    if (!Array.isArray(body.content)) throw new ModelProviderError('server');
    const blocks: ModelBlock[] = [];
    for (const raw of body.content as Record<string, unknown>[]) {
      if (raw.type === 'text' && typeof raw.text === 'string') {
        blocks.push({ type: 'text', text: raw.text });
      } else if (
        raw.type === 'tool_use' &&
        typeof raw.id === 'string' &&
        typeof raw.name === 'string'
      ) {
        blocks.push({ type: 'tool-call', id: raw.id, name: raw.name, input: raw.input });
      }
      // Any other block (thinking, for one) is not shown and not kept.
    }
    const usage = body.usage ?? {};
    return {
      blocks,
      stop: STOPS[String(body.stop_reason)] ?? 'other',
      usage: {
        inputTokens:
          count(usage.input_tokens) +
          count(usage.cache_creation_input_tokens) +
          count(usage.cache_read_input_tokens),
        outputTokens: count(usage.output_tokens),
      },
    };
  }
}
