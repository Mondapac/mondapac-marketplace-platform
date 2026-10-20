import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MarketId } from '@mondapac/shared-kernel';
import type { AppConfig, ModelTokenPrice } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import {
  MODEL_PROVIDER,
  type ModelProvider,
  type ModelRequest,
  type ModelTurn,
} from './model-provider';

/** The model tiers a Market configures; an admin setting chooses one. */
export const AI_MODEL_TIERS = ['fast', 'balanced'] as const;
export type AiModelTier = (typeof AI_MODEL_TIERS)[number];

export type { ModelTokenPrice };

/** The answer of one call: the turn and the price it is counted at, or why there is none. */
export type ModelCall =
  | { readonly ok: true; readonly turn: ModelTurn; readonly price: ModelTokenPrice }
  | { readonly ok: false; readonly failure: 'not-configured' }
  /** A call was sent; `price` lets the caller count what the provider may still bill. */
  | {
      readonly ok: false;
      readonly failure: 'timeout' | 'unavailable';
      readonly price: ModelTokenPrice;
    };

/**
 * The one model entry point (ADR-0019 decision 6, R7): only files on the allow-list of the
 * boundary rule `model-entry-only-from-the-allow-list` import it. Provider, model, key and price are
 * Market configuration with no default (`ASSISTANT_MODEL_*`); a Market missing any of them is not
 * configured and nothing is called (fail closed). The key never leaves this class: callers learn
 * only whether a Market is configured.
 *
 * Callers never call it inside a UnitOfWork (decision 6): a slow provider must not hold a
 * database transaction. A call is cut at its timeout; any provider failure is `unavailable`,
 * logged with the Market and the failure kind only (never a message, a key or provider text).
 */
@Injectable()
export class ModelGateway {
  readonly #logger = new Logger('ModelGateway');
  readonly #config: AppConfig['assistantModels'];

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(MODEL_PROVIDER) private readonly provider: ModelProvider,
  ) {
    this.#config = config.assistantModels;
  }

  /** Whether the Market has a provider key (the admin screen shows set or not set). */
  keyConfigured(marketId: MarketId): boolean {
    return Object.hasOwn(this.#config.apiKeys, marketId);
  }

  /** The model id configured for a tier in the Market, or null. */
  modelOf(marketId: MarketId, tier: AiModelTier): string | null {
    return Object.hasOwn(this.#config.models[tier], marketId)
      ? this.#config.models[tier][marketId]!
      : null;
  }

  /** Key, model and price are all set for this tier in the Market. */
  configured(marketId: MarketId, tier: AiModelTier): boolean {
    return (
      this.keyConfigured(marketId) &&
      this.modelOf(marketId, tier) !== null &&
      Object.hasOwn(this.#config.prices[tier], marketId)
    );
  }

  async complete(
    marketId: MarketId,
    tier: AiModelTier,
    request: ModelRequest,
    timeoutMs: number,
  ): Promise<ModelCall> {
    if (!this.configured(marketId, tier)) return { ok: false, failure: 'not-configured' };
    const credentials = {
      apiKey: this.#config.apiKeys[marketId]!,
      model: this.modelOf(marketId, tier)!,
    };
    const price = this.#config.prices[tier][marketId]!;
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
      return { ok: true, turn, price };
    } catch {
      const failure = abort.signal.aborted ? 'timeout' : 'unavailable';
      this.#logger.warn({ msg: 'ai.model-call.failed', marketId, tier, failure });
      return { ok: false, failure, price };
    } finally {
      clearTimeout(timer);
    }
  }
}
