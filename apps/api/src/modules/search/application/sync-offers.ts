import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  clip,
  MAX_DOCUMENT_CATEGORIES,
  MAX_NAME,
  MAX_SHORT_TEXT,
  type OfferDocument,
} from '../domain/offer-document';
import type { FeedFacts } from './ports/offer-feed';
import type { SearchDependencies } from './search-dependencies';

/** Offers per catalog read (its facade takes at most 200). */
export const SYNC_BATCH = 200;

export interface SyncCounts {
  readonly upserted: number;
  readonly deleted: number;
}

/**
 * The document of an Offer, or null when it must not be indexed: catalog says it is not
 * sellable, or the published revision has no text in the Market's locale. Pure.
 */
export function documentOf(
  offerId: Id<'Offer'>,
  facts: FeedFacts | undefined,
  settings: { readonly locale: string; readonly textSearchConfig: string },
): OfferDocument | null {
  if (facts === undefined || !facts.sellable || facts.name === null) return null;
  const name = clip(facts.name, MAX_NAME);
  if (name === '') return null;
  const shortText = facts.shortText === null ? '' : clip(facts.shortText, MAX_SHORT_TEXT);
  return {
    offerId,
    productId: facts.productId,
    sellerId: facts.sellerId,
    locale: settings.locale,
    name,
    shortText: shortText === '' ? null : shortText,
    categoryIds: [...new Set(facts.categoryIds)].slice(0, MAX_DOCUMENT_CATEGORIES),
    textSearchConfig: settings.textSearchConfig,
  };
}

/**
 * Brings the documents of these Offers in line with catalog: re-reads each Offer's current state
 * through the index facade (never trusts an event's payload for content), then upserts the
 * sellable ones and deletes the others in one write unit. Idempotent, so a repeated or
 * out-of-order delivery converges. A failed read or write throws (the delivery is retried).
 */
export async function syncOffers(
  deps: SearchDependencies,
  context: CallContext,
  offerIds: readonly Id<'Offer'>[],
): Promise<SyncCounts> {
  const { market } = context;
  const settings = deps.policy.settings(market);
  const unique = [...new Set(offerIds)];
  let upserted = 0;
  let deleted = 0;
  for (let at = 0; at < unique.length; at += SYNC_BATCH) {
    const batch = unique.slice(at, at + SYNC_BATCH);
    const facts = await deps.feed.facts(context, batch, settings.locale);
    if (facts === null) throw new Error('search: catalog facts unavailable');
    const documents: OfferDocument[] = [];
    const removals: Id<'Offer'>[] = [];
    for (const offerId of batch) {
      const document = documentOf(offerId, facts.get(offerId), settings);
      if (document === null) removals.push(offerId);
      else documents.push(document);
    }
    const indexedAt = deps.clock.now();
    const written = await deps.unitOfWork.run(market, async () => {
      for (const document of documents) await deps.documents.upsert(market, document, indexedAt);
      const removed = await deps.documents.deleteMany(market, removals);
      return ok(removed);
    });
    if (!written.ok) throw new Error('search: the index write failed');
    upserted += documents.length;
    deleted += written.value;
  }
  return { upserted, deleted };
}
