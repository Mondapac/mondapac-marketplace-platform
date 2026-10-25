import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogAssistantFacade, CatalogFacade } from '../../catalog';
import type { SellersFacade } from '../../sellers';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import { targetKey, type SlideTarget, type SlideTargets } from '../application/ports/slide-targets';

const SELLER_BATCH = 100;

/**
 * {@link SlideTargets} over the public facades of catalog (the category tree, the published
 * product) and sellers (the may-sell contract), each called with the request's context unchanged.
 * Any refusal or failure is `null`: the caller fails closed.
 */
export class FacadeSlideTargets implements SlideTargets {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly categories: CatalogAssistantFacade,
    private readonly sellers: SellersFacade,
    private readonly markets: MarketRegistry,
  ) {}

  async live(
    context: CallContext,
    targets: readonly SlideTarget[],
  ): Promise<ReadonlySet<string> | null> {
    const live = new Set<string>();
    try {
      const wanted = (type: SlideTarget['type']) => [
        ...new Set(targets.filter((t) => t.type === type).map((t) => t.id)),
      ];
      if (wanted('category').length > 0) {
        const tree = await this.categories.categories(context);
        if (!tree.ok) return null;
        const ids = new Set<string>(tree.value.map((category) => category.id));
        for (const id of wanted('category')) {
          if (ids.has(id)) live.add(targetKey({ type: 'category', id }));
        }
      }
      const locale = this.markets.get(context.market.marketId).defaultLocale;
      for (const id of wanted('product')) {
        const product = await this.catalog.publishedProduct(context, id as Id<'Product'>, locale);
        if (!product.ok) return null;
        if (product.value !== null) live.add(targetKey({ type: 'product', id }));
      }
      const sellerIds = wanted('seller') as Id<'Seller'>[];
      for (let at = 0; at < sellerIds.length; at += SELLER_BATCH) {
        const answer = await this.sellers.sellingEligibility(
          context,
          sellerIds.slice(at, at + SELLER_BATCH),
        );
        if (!answer.ok) return null;
        for (const [id, { eligible }] of answer.value) {
          if (eligible) live.add(targetKey({ type: 'seller', id }));
        }
      }
    } catch {
      return null;
    }
    return live;
  }
}
