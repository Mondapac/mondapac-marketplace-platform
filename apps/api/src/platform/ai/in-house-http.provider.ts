import { inHouseEndpointProblem } from './catalogue/route-catalogue';
import type { Fetch } from './anthropic-messages.provider';
import {
  ModelProviderError,
  type ModelBlock,
  type ModelCredentials,
  type ModelProvider,
  type ModelRequest,
  type ModelStop,
  type ModelTurn,
} from './model-provider';

/**
 * The contract version this adapter speaks, sent in the body and in a header. A server answering
 * another version is an outage of the route (`route`), never read (ADR-0052 decision 6).
 */
export const IN_HOUSE_CONTRACT = 'mondapac-model/1';

/** The largest answer body read, in bytes; a bigger one is a server fault and is not parsed. */
export const IN_HOUSE_MAX_ANSWER_BYTES = 1_048_576;

const STOPS: ReadonlySet<string> = new Set(['end', 'tool-use', 'max-tokens', 'refusal']);

/** The answers that say the request itself cannot be taken, on any route. */
const REQUEST_REFUSED = new Set([400, 413, 422]);

function failureOf(status: number): ModelProviderError {
  if (status === 429) return new ModelProviderError('rate-limited');
  if (status >= 500) return new ModelProviderError('server');
  if (REQUEST_REFUSED.has(status)) return new ModelProviderError('client');
  return new ModelProviderError('route');
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * The in-house model's adapter (Mondapac Intelligence, ADR-0052 decision 6; AI Gateway G6a): the
 * versioned HTTP contract `mondapac-model/1` of `docs/design/domain/platform-ai-in-house-contract-v1.md`,
 * over plain HTTPS. The request is our own provider-neutral message format ({@link ModelRequest}),
 * already masked by the gateway; the answer names the model version that served it and its token
 * counts, both required, so a call is always bound to the evaluated version and counted at the
 * catalogue price.
 *
 * The endpoint is the catalogue row's (code, changed only by PR) and is checked again here, so no
 * other host is reached; the key is the Market's server key, sent as a bearer token. Redirects are
 * never followed. The answer is checked strictly and anything outside the contract fails the call
 * without its text: a wrong contract or model version is an outage of the route (`route`), so the
 * router moves to the next one; a malformed body, missing token counts or a tool the request did
 * not offer is a server fault (`server`). Non-streaming, one model round per call.
 */
export class InHouseHttpProvider implements ModelProvider {
  constructor(private readonly fetchFn: Fetch = (url, init) => fetch(url, init)) {}

  async call(
    credentials: ModelCredentials,
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelTurn> {
    const endpoint = credentials.endpoint;
    if (
      credentials.route !== 'in-house-http' ||
      endpoint === null ||
      inHouseEndpointProblem(endpoint) !== null
    ) {
      throw new ModelProviderError('client');
    }
    const url = `${endpoint.replace(/\/$/, '')}/v1/messages`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${credentials.apiKey}`,
          'mondapac-contract': IN_HOUSE_CONTRACT,
          // The contract's terms, stated on every call: neither request nor answer is kept.
          'mondapac-retention': 'none',
        },
        body: JSON.stringify({
          contract: IN_HOUSE_CONTRACT,
          model: credentials.model,
          system: request.system,
          messages: request.messages.map((message) => ({
            role: message.role,
            blocks: message.blocks,
          })),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
          maxOutputTokens: request.maxOutputTokens,
        }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ModelProviderError('network');
    }
    if (response.status !== 200) {
      // The body is not read: it may echo the request.
      throw failureOf(response.status);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > IN_HOUSE_MAX_ANSWER_BYTES) {
      throw new ModelProviderError('server');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > IN_HOUSE_MAX_ANSWER_BYTES) {
      throw new ModelProviderError('server');
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ModelProviderError('server');
    }
    return turnOf(body, credentials.model, new Set(request.tools.map((tool) => tool.name)));
  }
}

/** The checked turn of a contract answer; throws a {@link ModelProviderError} otherwise. */
function turnOf(body: unknown, model: string, offered: ReadonlySet<string>): ModelTurn {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ModelProviderError('server');
  }
  const answer = body as Record<string, unknown>;
  // Another contract, or another model version than the one evaluated and asked for, is not this
  // route as the catalogue recorded it: the next route is tried.
  if (answer.contract !== IN_HOUSE_CONTRACT || answer.model !== model) {
    throw new ModelProviderError('route');
  }
  const usage = answer.usage as Record<string, unknown> | undefined;
  if (
    typeof usage !== 'object' ||
    usage === null ||
    !isCount(usage.inputTokens) ||
    !isCount(usage.outputTokens)
  ) {
    throw new ModelProviderError('server');
  }
  if (typeof answer.stop !== 'string' || !STOPS.has(answer.stop)) {
    throw new ModelProviderError('server');
  }
  if (!Array.isArray(answer.blocks)) throw new ModelProviderError('server');
  const blocks: ModelBlock[] = [];
  for (const raw of answer.blocks as unknown[]) {
    if (typeof raw !== 'object' || raw === null) throw new ModelProviderError('server');
    const block = raw as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (
      block.type === 'tool-call' &&
      typeof block.id === 'string' &&
      block.id.length > 0 &&
      block.id.length <= 200 &&
      typeof block.name === 'string' &&
      offered.has(block.name)
    ) {
      blocks.push({ type: 'tool-call', id: block.id, name: block.name, input: block.input });
    } else {
      // A tool the request did not offer, a result block, or an unknown type: outside the
      // contract, so the whole answer is refused rather than partly used.
      throw new ModelProviderError('server');
    }
  }
  const stop = answer.stop as ModelStop;
  if (stop === 'tool-use' && !blocks.some((block) => block.type === 'tool-call')) {
    throw new ModelProviderError('server');
  }
  return {
    blocks,
    stop,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
}
