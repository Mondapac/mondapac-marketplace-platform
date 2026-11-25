import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MarketId } from '@mondapac/shared-kernel';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import {
  AI_ROUTE_CATALOGUE,
  type ModelTokenPrice,
  type RouteCatalogue,
  type RouteKind,
  type RouteRow,
} from './catalogue/route-catalogue';
import {
  MODEL_PROVIDER,
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelTurn,
} from './model-provider';

/** The model tiers a Market configures; an admin setting chooses one. */
export const AI_MODEL_TIERS = ['fast', 'balanced'] as const;
export type AiModelTier = (typeof AI_MODEL_TIERS)[number];

export type { ModelTokenPrice };

/**
 * How one call on one route ended. `rate-limited`, `unavailable` (a server error or no answer)
 * and `timeout` let the router move to the next route; `rejected` (the provider refused the
 * request itself) does not, as the same model on another route would refuse it too.
 */
export type ModelCall =
  | { readonly ok: true; readonly turn: ModelTurn }
  | { readonly ok: false; readonly failure: 'not-configured' }
  | {
      readonly ok: false;
      readonly failure: 'timeout' | 'unavailable' | 'rate-limited' | 'rejected';
    };

/**
 * The one model entry point (ADR-0019 decision 6, R7): only files on the allow-list of the
 * boundary rule `model-entry-only-from-the-allow-list` import it. It calls one catalogue route row
 * (ADR-0052) with that route's server key for the Market; the key never leaves this class: callers
 * learn only whether a Market has one. Which row to call is the router's choice (`routing/`).
 *
 * `ASSISTANT_MODEL_API_KEY` is the key of the `anthropic-api` route and `AI_BEDROCK_API_KEY` that
 * of the `bedrock-mantle` route, per Market. `ASSISTANT_MODEL_FAST` and `_BALANCED` name the model
 * family each tier uses in a Market until the priority lists move to settings (G4); a name outside
 * the catalogue fails boot. Prices come from the catalogue only.
 *
 * `AI_KILL_SWITCH` (ADR-0026 decision 8) makes every Market not configured: nothing is called.
 *
 * Callers never call it inside a UnitOfWork (decision 6): a slow provider must not hold a
 * database transaction. A call is cut at its timeout; the AI Gateway logs a failure once.
 */
@Injectable()
export class ModelGateway {
  readonly #logger = new Logger('ModelGateway');
  readonly #config: AppConfig['assistantModels'];
  readonly #killed: boolean;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(MODEL_PROVIDER) private readonly provider: ModelProvider,
    @Inject(AI_ROUTE_CATALOGUE) private readonly catalogue: RouteCatalogue,
  ) {
    this.#config = config.assistantModels;
    this.#killed = config.aiKillSwitch;
    if (this.#killed) {
      this.#logger.warn({ msg: 'ai.kill-switch.set', detail: 'every AI capability is off' });
    }
    // A tier naming a model outside the catalogue is a configuration error. It is logged and the
    // tier is off (`modelOf` answers null): an AI setting never stops the host from booting (R8;
    // Mohammad, G3 review 7).
    for (const tier of AI_MODEL_TIERS) {
      for (const [market, name] of Object.entries(this.#config.models[tier])) {
        if (this.catalogue.familyOf(name) === null) {
          this.#logger.error({
            msg: 'ai.model.unknown',
            detail:
              `ASSISTANT_MODEL_${tier.toUpperCase()}: ${market} names a model that is not in the ` +
              'AI route catalogue (apps/api/src/platform/ai/catalogue); the tier is off',
          });
        }
      }
    }
  }

  /** `AI_KILL_SWITCH` is set: every Market answers not configured and nothing is called. */
  killSwitchSet(): boolean {
    return this.#killed;
  }

  /** Whether the Market has a key for Anthropic's own API (the admin screen shows set or not). */
  keyConfigured(marketId: MarketId): boolean {
    return this.#keyOf(marketId, 'anthropic-api') !== null;
  }

  /** Whether a call on the route can be sent now: no kill switch, and the Market holds its key. */
  callable(marketId: MarketId, route: RouteKind): boolean {
    return !this.#killed && this.#keyOf(marketId, route) !== null;
  }

  /** Whether the Market has the server key of a route. */
  routeKeyConfigured(marketId: MarketId, route: RouteKind): boolean {
    return this.#keyOf(marketId, route) !== null;
  }

  /** The model family configured for a tier in the Market, or null. */
  modelOf(marketId: MarketId, tier: AiModelTier): string | null {
    const name = Object.hasOwn(this.#config.models[tier], marketId)
      ? this.#config.models[tier][marketId]!
      : null;
    return name === null ? null : this.catalogue.familyOf(name);
  }

  async complete(
    marketId: MarketId,
    row: RouteRow,
    request: ModelRequest,
    timeoutMs: number,
  ): Promise<ModelCall> {
    const apiKey = this.#keyOf(marketId, row.route);
    if (this.#killed || apiKey === null) return { ok: false, failure: 'not-configured' };
    const credentials = { apiKey, model: row.model, route: row.route, region: row.region };
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    // The cut does not rely on the provider honouring the signal.
    const cut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    try {
      const turn = await Promise.race([
        this.provider.call(credentials, request, abort.signal),
        cut,
      ]);
      return { ok: true, turn };
    } catch (error) {
      if (abort.signal.aborted) return { ok: false, failure: 'timeout' };
      const kind = error instanceof ModelProviderError ? error.kind : 'network';
      return {
        ok: false,
        // `route` (a key or model the route refuses) is an outage of that route: the next route
        // is tried (Mohammad, G3 review 1). Only a request the provider cannot take is `rejected`.
        failure:
          kind === 'rate-limited' ? 'rate-limited' : kind === 'client' ? 'rejected' : 'unavailable',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  #keyOf(marketId: MarketId, route: RouteKind): string | null {
    const keys = route === 'anthropic-api' ? this.#config.apiKeys : this.#config.bedrockApiKeys;
    return Object.hasOwn(keys, marketId) ? keys[marketId]! : null;
  }
}
