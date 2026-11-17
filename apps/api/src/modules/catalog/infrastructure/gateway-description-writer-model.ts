import type { MarketContext } from '@mondapac/shared-kernel';
import type { ModelGateway } from '../../../platform/ai/model-gateway';
import type {
  DescriptionWriterModel,
  WriterModelAnswer,
  WriterModelTier,
} from '../application/ports/description-writer';

/**
 * {@link DescriptionWriterModel} on `platform/ai`'s one entry point. This file and
 * `catalog-providers.ts` are catalog's only entries on the boundary allow-list
 * (`.dependency-cruiser.cjs`, catalog design 13.3). One user message, no tools: the answer is
 * used only when the model ended its turn normally and gave text alone.
 */
export class GatewayDescriptionWriterModel implements DescriptionWriterModel {
  constructor(private readonly gateway: ModelGateway) {}

  configured(market: MarketContext, tier: WriterModelTier): boolean {
    return this.gateway.configured(market.marketId, tier);
  }

  setup(market: MarketContext) {
    return {
      killSwitch: this.gateway.killSwitchSet(),
      keyConfigured: this.gateway.keyConfigured(market.marketId),
      models: {
        fast: this.gateway.modelOf(market.marketId, 'fast'),
        balanced: this.gateway.modelOf(market.marketId, 'balanced'),
      },
    };
  }

  async write(
    market: MarketContext,
    tier: WriterModelTier,
    request: { readonly system: string; readonly input: string; readonly maxOutputTokens: number },
    timeoutMs: number,
  ): Promise<WriterModelAnswer> {
    const call = await this.gateway.complete(
      market.marketId,
      tier,
      {
        system: request.system,
        messages: [{ role: 'user', blocks: [{ type: 'text', text: request.input }] }],
        tools: [],
        maxOutputTokens: request.maxOutputTokens,
      },
      timeoutMs,
    );
    if (!call.ok) return { ok: false, failure: call.failure };
    const { turn } = call;
    if (turn.stop !== 'end' || turn.blocks.some((block) => block.type !== 'text')) {
      return { ok: false, failure: 'incomplete' };
    }
    const text = turn.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
    return text.trim().length === 0 ? { ok: false, failure: 'incomplete' } : { ok: true, text };
  }
}
