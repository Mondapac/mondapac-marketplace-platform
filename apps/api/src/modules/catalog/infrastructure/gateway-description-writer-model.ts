import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import type { AiGateway, GatewayOptions } from '../../../platform/ai/ai-gateway';
import { DESCRIPTION_WRITER_ADMIN, DESCRIPTION_WRITER_SELLER } from '../contracts/ai-capabilities';
import type {
  DescriptionWriterModel,
  WriterAudience,
  WriterModelAnswer,
  WriterModelTier,
} from '../application/ports/description-writer';

const capabilityOf = (audience: WriterAudience): string =>
  audience.kind === 'seller' ? DESCRIPTION_WRITER_SELLER : DESCRIPTION_WRITER_ADMIN;

const optionsOf = (audience: WriterAudience, tier: WriterModelTier): GatewayOptions =>
  audience.kind === 'seller' ? { tier, sellerId: audience.sellerId } : { tier };

/**
 * {@link DescriptionWriterModel} on `platform/ai`'s gateway. This file and `catalog-providers.ts`
 * are catalog's only entries on the boundary allow-list (`.dependency-cruiser.cjs`, catalog design
 * 13.3). One user message, no tools: the answer is used only when the model ended its turn normally
 * and gave text alone.
 */
export class GatewayDescriptionWriterModel implements DescriptionWriterModel {
  constructor(private readonly gateway: AiGateway) {}

  async available(
    context: CallContext,
    audience: WriterAudience,
    tier: WriterModelTier,
  ): Promise<boolean> {
    return (await this.gateway.status(capabilityOf(audience), context, optionsOf(audience, tier)))
      .on;
  }

  setup(market: MarketContext) {
    return this.gateway.setup(market.marketId);
  }

  async write(
    context: CallContext,
    audience: WriterAudience,
    tier: WriterModelTier,
    request: { readonly system: string; readonly input: string; readonly maxOutputTokens: number },
    timeoutMs: number,
  ): Promise<WriterModelAnswer> {
    const run = await this.gateway.run(
      capabilityOf(audience),
      context,
      {
        system: request.system,
        messages: [{ role: 'user', blocks: [{ type: 'text', text: request.input }] }],
        tools: [],
        maxOutputTokens: request.maxOutputTokens,
      },
      { ...optionsOf(audience, tier), timeoutMs },
    );
    if (!run.ok) {
      return {
        ok: false,
        failure:
          run.reason === 'off'
            ? 'not-configured'
            : run.reason === 'timeout'
              ? 'timeout'
              : 'unavailable',
      };
    }
    const { turn } = run;
    if (turn.stop !== 'end' || turn.blocks.some((block) => block.type !== 'text')) {
      return { ok: false, failure: 'incomplete' };
    }
    const text = turn.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
    return text.trim().length === 0 ? { ok: false, failure: 'incomplete' } : { ok: true, text };
  }
}
