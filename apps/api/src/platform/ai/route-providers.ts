import type { RouteKind } from './catalogue/route-catalogue';
import {
  ModelProviderError,
  type ModelCredentials,
  type ModelProvider,
  type ModelRequest,
  type ModelTurn,
} from './model-provider';

/**
 * The {@link ModelProvider} the gateway is given: it sends each call to the adapter of the
 * catalogue row's route kind (G6a). The Anthropic Messages adapter serves `anthropic-api` and
 * `bedrock-mantle`, the in-house adapter `in-house-http`. A route without an adapter is refused
 * as `client` before anything is sent.
 */
export class RouteProviders implements ModelProvider {
  constructor(private readonly adapters: Readonly<Record<RouteKind, ModelProvider>>) {}

  call(
    credentials: ModelCredentials,
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelTurn> {
    const adapter = Object.hasOwn(this.adapters, credentials.route)
      ? this.adapters[credentials.route as RouteKind]
      : undefined;
    if (adapter === undefined) return Promise.reject(new ModelProviderError('client'));
    return adapter.call(credentials, request, signal);
  }

  /** The route kind's adapter health check (G6d1); a kind without one is never healthy. */
  async health(credentials: ModelCredentials, signal: AbortSignal): Promise<boolean> {
    const adapter = Object.hasOwn(this.adapters, credentials.route)
      ? this.adapters[credentials.route as RouteKind]
      : undefined;
    if (adapter?.health === undefined) return false;
    try {
      return (await adapter.health(credentials, signal)) === true;
    } catch {
      return false;
    }
  }
}
