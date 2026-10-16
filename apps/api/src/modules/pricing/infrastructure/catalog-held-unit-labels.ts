import type { CallContext } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import { sellUnitKey } from '../../catalog';
import {
  heldUnitKey,
  type HeldUnitKey,
  type HeldUnitLabel,
  type HeldUnitLabels,
} from '../application/ports/held-labels';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';

/**
 * {@link HeldUnitLabels} over catalog's facade `sellUnitLabels` (published content only). The
 * caller's `CallContext` goes through unchanged; the locale is the Market's default. Any refusal
 * is thrown: the caller shows no names, it never reads a refusal as "no label".
 */
export class CatalogHeldUnitLabels implements HeldUnitLabels {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly markets: MarketRegistry,
  ) {}

  async labelsOf(
    context: CallContext,
    keys: readonly HeldUnitKey[],
  ): Promise<ReadonlyMap<string, HeldUnitLabel>> {
    const locale = this.markets.get(context.market.marketId).defaultLocale;
    const answer = await this.catalog.sellUnitLabels(context, keys, locale);
    if (!answer.ok) throw new Error(`catalog.sellUnitLabels: ${answer.error.code}`);
    const result = new Map<string, HeldUnitLabel>();
    for (const key of keys) {
      // Only what was asked for: an extra key in the answer is ignored.
      const label = answer.value.get(sellUnitKey(key));
      if (label !== undefined) {
        result.set(heldUnitKey(key), {
          productName: label.productName,
          variantLabel: label.variantLabel,
        });
      }
    }
    return result;
  }
}
