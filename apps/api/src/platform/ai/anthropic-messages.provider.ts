import type {
  ModelBlock,
  ModelCredentials,
  ModelProvider,
  ModelRequest,
  ModelStop,
  ModelTurn,
} from './model-provider';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

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
 * package enters the dependency tree). Non-streaming: the assistant checks a whole answer before
 * the buyer sees any of it. The fixed instructions are marked for prompt caching. Any answer that
 * is not a 200 with the expected shape throws, with no provider text in the error.
 */
export class AnthropicMessagesProvider implements ModelProvider {
  constructor(private readonly fetchFn: Fetch = (url, init) => fetch(url, init)) {}

  async call(
    credentials: ModelCredentials,
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelTurn> {
    const response = await this.fetchFn(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': credentials.apiKey,
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
    if (response.status !== 200) {
      // The body is not read: it may echo the request.
      throw new Error(`model provider answered ${response.status}`);
    }
    const body = (await response.json()) as {
      content?: unknown;
      stop_reason?: unknown;
      usage?: Record<string, unknown>;
    };
    if (!Array.isArray(body.content)) throw new Error('model provider answer has no content');
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
