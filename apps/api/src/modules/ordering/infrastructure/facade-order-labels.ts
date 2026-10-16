import type { CallContext, Id } from '@mondapac/shared-kernel';
import { MAX_FACADE_BATCH, sellUnitKey, type CatalogFacade } from '../../catalog';
import type { IdentityFacade } from '../../identity';
import type { SellersFacade } from '../../sellers';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  orderUnitKey,
  type OrderCustomer,
  type OrderLabels,
  type OrderUnitKey,
  type OrderUnitLabel,
} from '../application/ports/order-labels';

/** sellers' and identity's batch limit. */
const MAX_ID_BATCH = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

/**
 * {@link OrderLabels} over the facades of catalog, sellers and identity. The caller's
 * `CallContext` goes through unchanged; the locale is the Market's default. Larger requests are
 * split to each facade's batch limit. Any refusal is thrown (the caller shows no names), except
 * identity's `access.denied`, which is the expected answer for an admin without the customer key.
 */
export class FacadeOrderLabels implements OrderLabels {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly sellers: SellersFacade,
    private readonly identity: IdentityFacade,
    private readonly markets: MarketRegistry,
  ) {}

  async unitLabelsOf(
    context: CallContext,
    keys: readonly OrderUnitKey[],
  ): Promise<ReadonlyMap<string, OrderUnitLabel>> {
    const locale = this.markets.get(context.market.marketId).defaultLocale;
    const result = new Map<string, OrderUnitLabel>();
    for (const batch of chunks(keys, MAX_FACADE_BATCH)) {
      const answer = await this.catalog.sellUnitLabels(context, batch, locale);
      if (!answer.ok) throw new Error(`catalog.sellUnitLabels: ${answer.error.code}`);
      for (const key of batch) {
        // Only what was asked for: an extra key in the answer is ignored.
        const label = answer.value.get(sellUnitKey(key));
        if (label !== undefined) {
          result.set(orderUnitKey(key), {
            productName: label.productName,
            variantLabel: label.variantLabel,
          });
        }
      }
    }
    return result;
  }

  async storeNamesOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>> {
    const requested = new Set(sellerIds);
    const names = new Map<Id<'Seller'>, string>();
    for (const batch of chunks([...requested], MAX_ID_BATCH)) {
      const answer = await this.sellers.sellerSummaries(context, batch);
      if (!answer.ok) throw new Error(`sellers.sellerSummaries: ${answer.error.code}`);
      for (const summary of answer.value) {
        if (requested.has(summary.sellerId) && typeof summary.storeName === 'string') {
          names.set(summary.sellerId, summary.storeName);
        }
      }
    }
    return names;
  }

  async customersOf(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlyMap<Id<'Account'>, OrderCustomer>> {
    const requested = new Set(accountIds);
    const customers = new Map<Id<'Account'>, OrderCustomer>();
    for (const batch of chunks([...requested], MAX_ID_BATCH)) {
      const answer = await this.identity.customerAccountSummaries(context, batch);
      if (!answer.ok) {
        if (answer.error.code === 'access.denied') return new Map();
        throw new Error(`identity.customerAccountSummaries: ${answer.error.code}`);
      }
      for (const summary of answer.value) {
        if (requested.has(summary.accountId)) {
          customers.set(summary.accountId, {
            displayName: summary.displayName,
            email: summary.email,
          });
        }
      }
    }
    return customers;
  }
}
