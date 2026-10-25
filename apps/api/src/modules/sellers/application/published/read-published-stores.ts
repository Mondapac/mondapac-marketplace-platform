import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Money, Result } from '@mondapac/shared-kernel';
import type { DeliveryTerms } from '../../domain/delivery-terms';
import {
  sellingSinceOf,
  type ApprovedStoreFacts,
  type PublishedStore,
} from '../../domain/published-store';
import type { MinimumOrderPolicy } from '../ports/minimum-order-policy';
import type { PublishedStoreRepository } from '../ports/published-store.repository';
import type { StoreProfileRepository } from '../ports/store-profile.repository';
import {
  sellingEligibilityFor,
  type SellingEligibilityDependencies,
} from '../use-cases/selling-eligibility.use-case';
import { MAX_SELLER_SUMMARY_IDS } from '../summaries/read-seller-summaries';
import type { PublishedStoreContentReader } from '../store-profile/published-store-content';

/**
 * The most stores one list read considers. Above it the list answers the first stores in seller
 * id order and logs an error: a read model (sellers design 16.2 item 7) must replace this read
 * before a Market has that many approved sellers.
 */
export const MAX_PUBLISHED_STORES = 1000;

export interface PublishedStoresDependencies extends SellingEligibilityDependencies {
  readonly publishedStores: PublishedStoreRepository;
  readonly storeProfiles: StoreProfileRepository;
  readonly minimumOrderPolicy: MinimumOrderPolicy;
  /** The About text, logo and banner of a store (slice 12 part 2). */
  readonly publishedContent: PublishedStoreContentReader;
  readonly clock: Clock;
}

export type PublishedStoresUnavailable = { readonly code: 'sellers.unavailable' };

const logger = new Logger('PublishedStores');

const chunks = <T>(values: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    out.push(values.slice(start, start + size));
  }
  return out;
};

/** Reads the qualifying stores of the Market in one read-only unit; a failed unit throws. */
export async function readApproved<T>(
  deps: PublishedStoresDependencies,
  context: CallContext,
  read: (repository: PublishedStoreRepository) => Promise<T>,
): Promise<T> {
  const result = await deps.unitOfWork.run(
    context.market,
    async () => ok(await read(deps.publishedStores)),
    { readOnly: true },
  );
  if (!result.ok) throw new Error('the read unit failed');
  return result.value;
}

/**
 * The stores that may sell now (the may-sell contract, sellers design 7.2), in the given order.
 * A store the contract does not answer yes for is left out. A refused batch throws, so the caller
 * answers a logged `sellers.unavailable` rather than a silently shorter list (Hassan, #449 L3).
 */
export async function eligibleOnly(
  deps: PublishedStoresDependencies,
  context: CallContext,
  stores: readonly ApprovedStoreFacts[],
): Promise<ApprovedStoreFacts[]> {
  const yes = new Set<Id<'Seller'>>();
  for (const batch of chunks(stores, MAX_SELLER_SUMMARY_IDS)) {
    const answer = await sellingEligibilityFor(
      deps,
      context,
      batch.map((store) => store.sellerId),
    );
    if (!answer.ok) throw new Error('the may-sell contract refused the batch');
    for (const [sellerId, { eligible }] of answer.value) if (eligible) yes.add(sellerId);
  }
  return stores.filter((store) => yes.has(store.sellerId));
}

/**
 * The public answer for each store: the allow-listed fields and the minimum order, read for these
 * stores only. A stored currency that is not the Market's leaves `minimumOrder` out and writes an
 * error log (ids and codes only), as `sellerSummaries` does.
 */
export async function publishedStoresOf(
  deps: PublishedStoresDependencies,
  context: CallContext,
  stores: readonly ApprovedStoreFacts[],
): Promise<PublishedStore[]> {
  const { market } = context;
  const minimums = new Map<Id<'Seller'>, Money | null>();
  for (const batch of chunks(stores, MAX_SELLER_SUMMARY_IDS)) {
    const result = await deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await deps.storeProfiles.approvedMinimumOrders(
            market,
            batch.map((store) => store.sellerId),
          ),
        ),
      { readOnly: true },
    );
    if (!result.ok) throw new Error('the read unit failed');
    for (const [sellerId, minimum] of result.value) minimums.set(sellerId, minimum);
  }
  const deliveries = new Map<Id<'Seller'>, DeliveryTerms>();
  for (const batch of chunks(stores, MAX_SELLER_SUMMARY_IDS)) {
    const result = await deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await deps.storeProfiles.approvedDeliveryTerms(
            market,
            batch.map((store) => store.sellerId),
          ),
        ),
      { readOnly: true },
    );
    if (!result.ok) throw new Error('the read unit failed');
    for (const [sellerId, terms] of result.value) deliveries.set(sellerId, terms);
  }
  const rule = deps.minimumOrderPolicy.rule(market);
  return stores.map((store): PublishedStore => {
    const terms = deliveries.get(store.sellerId);
    const base: PublishedStore = {
      slug: store.slug,
      name: store.name,
      serviceAreaCode: store.serviceAreaCode,
      sellingSince: sellingSinceOf(store),
      ...(terms === undefined ? {} : { delivery: terms }),
    };
    const minimum = minimums.get(store.sellerId);
    if (minimum === undefined) return base;
    if (minimum === null) return { ...base, minimumOrder: null };
    if (rule === null || minimum.currency !== rule.currency) {
      logger.error({
        msg: 'sellers.published-stores.minimum-order-currency-mismatch',
        sellerId: store.sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return base;
    }
    return { ...base, minimumOrder: minimum };
  });
}

/** Runs a public read; any fault is `sellers.unavailable` with an error log, never a partial answer. */
export async function failClosed<T>(
  context: CallContext,
  name: string,
  read: () => Promise<T>,
): Promise<Result<T, PublishedStoresUnavailable>> {
  try {
    return ok(await read());
  } catch (error) {
    logger.error({
      msg: `sellers.${name}.read-failed`,
      error: error instanceof Error ? error.name : 'unknown',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'sellers.unavailable' });
  }
}

export { logger as publishedStoresLogger };
