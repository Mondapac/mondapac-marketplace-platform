import type { Id, IdGenerator, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { TagActor } from '../../domain/offer-tag';
import type { OfferActor, OfferRepository } from '../ports/offer.repository';
import type { TagReevaluationRequestRepository } from '../ports/tag-reevaluation-requests';

export interface PublishFanOutDependencies {
  readonly offers: OfferRepository;
  readonly requests: TagReevaluationRequestRepository;
  readonly ids: IdGenerator;
}

/** Offers read per page while marking (the unit holds them all; one product's Offers). */
const MARK_PAGE = 200;

/**
 * The publish half of the fan-out (catalog design 5.4; Hassan M1, Ali): in the unit that moves a
 * PLATFORM product's published pointer, after the product row is written (lock order: product,
 * then Offers), every `active` tag of every Offer of the product becomes `rechecking` (no badge
 * until the fan-out asks again against the new revision), whatever the number of Offers, and one
 * `revision-published` request is written for the job `catalog.reevaluate-tags` (a pending
 * request of an older revision is superseded). Asks nothing: the job asks outside any unit.
 * Answers the number of tags marked.
 */
export async function markProductForReevaluation(
  deps: PublishFanOutDependencies,
  market: MarketContext,
  publish: {
    readonly productId: Id<'Product'>;
    readonly revisionId: Id<'ProductRevision'>;
    readonly actor: TagActor & OfferActor;
    readonly now: Temporal.Instant;
  },
): Promise<number> {
  let marked = 0;
  let afterId: Id<'Offer'> | null = null;
  for (;;) {
    const page = await deps.offers.listOnProduct(market, publish.productId, {
      afterId,
      limit: MARK_PAGE,
    });
    for (const offer of page) {
      const count = offer.markRechecking({
        entryPath: 'revision-publish',
        actor: publish.actor,
        now: publish.now,
      });
      if (count === 0) continue;
      marked += count;
      await deps.offers.save(market, offer, publish.actor);
    }
    const last = page[page.length - 1];
    if (last === undefined || page.length < MARK_PAGE) break;
    afterId = last.state.id;
  }
  await deps.requests.requestForPublish(market, {
    id: deps.ids.next<'TagReevaluationRequest'>(),
    productId: publish.productId,
    productRevisionId: publish.revisionId,
    now: publish.now,
  });
  return marked;
}
