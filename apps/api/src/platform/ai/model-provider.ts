/**
 * The provider-neutral shape of one model call (ADR-0019 decision 6). Only `platform/ai` sees a
 * provider's own format; a module builds these values and reads the answer through the
 * {@link ModelGateway}.
 */

/** A piece of a message: text, a tool call the model asked for, or the result the server gave. */
export type ModelBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool-result';
      readonly callId: string;
      /** JSON or plain text the server built; data, never instructions (R9). */
      readonly content: string;
      readonly isError: boolean;
    };

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly blocks: readonly ModelBlock[];
}

/** A read-only tool the model may ask for (R4: READ or DRAFT only; the server runs it). */
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  /** A JSON Schema object. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  /** The fixed instructions; cached by the provider when it can. */
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelTool[];
  readonly maxOutputTokens: number;
}

/** Tokens the provider counted for one call; cache reads and writes are counted as input. */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Why the model stopped: done, waiting for tool results, cut off, refused, or anything else. */
export type ModelStop = 'end' | 'tool-use' | 'max-tokens' | 'refusal' | 'other';

export interface ModelTurn {
  /** Text and tool calls only. */
  readonly blocks: readonly ModelBlock[];
  readonly stop: ModelStop;
  readonly usage: ModelUsage;
}

/**
 * What a provider adapter needs for one call; built by the gateway from the route catalogue row
 * (route, model, region) and the server key of that route in the Market.
 */
export interface ModelCredentials {
  readonly apiKey: string;
  readonly model: string;
  /** The catalogue row's route kind (`anthropic-api`, `bedrock-mantle`). */
  readonly route: string;
  /** The catalogue row's processing region; a regional route is called there only. */
  readonly region: string | null;
}

/**
 * How a call failed, as far as the router needs to know (design section 6): it moves to the next
 * route on `rate-limited`, `server` and `network`, never on `client` (a request the provider
 * refuses would be refused by the same model on another route).
 */
export type ProviderFailure = 'rate-limited' | 'server' | 'network' | 'client';

/** The error an adapter throws; it carries the kind only, never provider text. */
export class ModelProviderError extends Error {
  constructor(readonly kind: ProviderFailure) {
    super(`model provider failed: ${kind}`);
    this.name = 'ModelProviderError';
  }
}

/**
 * One provider's API (an adapter in `platform/ai`). It throws on any failure, a
 * {@link ModelProviderError} when it knows the kind; the gateway turns that into a failure reason
 * without its text, which could carry provider details. Any other error counts as `network`.
 */
export interface ModelProvider {
  call(
    credentials: ModelCredentials,
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelTurn>;
}

/** Nest token of the {@link ModelProvider}; tests bind a fake, so CI never calls a model. */
export const MODEL_PROVIDER = Symbol('MODEL_PROVIDER');
