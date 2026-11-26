import { inHouseCallUrl, inHouseEndpointProblem } from './catalogue/route-catalogue';
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
    // Built from the parsed address, never from the raw text (Hassan, G6a review 2).
    const url = inHouseCallUrl(endpoint);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          // No compressed answer: the size cap counts the bytes as sent (Hassan, G6a review 1).
          'accept-encoding': 'identity',
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
    const text = await readCapped(response);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ModelProviderError('server');
    }
    return turnOf(
      body,
      credentials.model,
      new Set(request.tools.map((tool) => tool.name)),
      request.maxOutputTokens,
    );
  }
}

/**
 * The answer body as UTF-8 text, read as a stream and cut at {@link IN_HOUSE_MAX_ANSWER_BYTES}: a
 * body over the cap, with or without a length header, is a server fault and is not read further
 * (Hassan, G6a review 1; Mohammad 5). A length header that is not a whole number is a fault too.
 */
async function readCapped(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d{1,12}$/.test(declared)) throw new ModelProviderError('server');
    if (Number(declared) > IN_HOUSE_MAX_ANSWER_BYTES) throw new ModelProviderError('server');
  }
  const encoding = response.headers.get('content-encoding');
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
    throw new ModelProviderError('server');
  }
  if (response.body === null) throw new ModelProviderError('server');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = (await reader.read()) as { done: boolean; value?: unknown };
    if (next.done) break;
    const value = next.value;
    if (!(value instanceof Uint8Array)) throw new ModelProviderError('server');
    size += value.byteLength;
    if (size > IN_HOUSE_MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ModelProviderError('server');
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new ModelProviderError('server');
  }
}

/** The checked turn of a contract answer; throws a {@link ModelProviderError} otherwise. */
function turnOf(
  body: unknown,
  model: string,
  offered: ReadonlySet<string>,
  maxOutputTokens: number,
): ModelTurn {
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
    !isCount(usage.outputTokens) ||
    // More output than asked for is not a model that honoured the request; the count feeds the caps.
    usage.outputTokens > maxOutputTokens
  ) {
    throw new ModelProviderError('server');
  }
  if (typeof answer.stop !== 'string' || !STOPS.has(answer.stop)) {
    throw new ModelProviderError('server');
  }
  if (!Array.isArray(answer.blocks)) throw new ModelProviderError('server');
  const blocks: ModelBlock[] = [];
  const callIds = new Set<string>();
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
      !callIds.has(block.id) &&
      typeof block.name === 'string' &&
      offered.has(block.name) &&
      typeof block.input === 'object' &&
      block.input !== null &&
      !Array.isArray(block.input)
    ) {
      callIds.add(block.id);
      blocks.push({ type: 'tool-call', id: block.id, name: block.name, input: block.input });
    } else {
      // A tool the request did not offer, a repeated call id, an input that is not an object, a
      // result block, or an unknown type: outside the contract, so the whole answer is refused.
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
