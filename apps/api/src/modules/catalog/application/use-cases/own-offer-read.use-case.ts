import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { OfferPostReviewRepository } from '../ports/offer-post-review';
import type { OfferPendingChangeRepository } from '../ports/offer-pending-change.repository';
import { ownOfferChangeViewOf } from '../offer-change-view';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import { offerViewOf, type OwnOfferView } from '../own-reads/own-offer-view';
import { invalid, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface OwnOfferReadInput {
  readonly offerId: string;
}

export type OwnOfferReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'offer.not-found' }
  | ValidationFailure;

export interface OwnOfferReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  /** The Offer's latest held change (slice 2c). */
  readonly pendingChanges: Pick<OfferPendingChangeRepository, 'findLatestByOffer'>;
  /** The Offer's latest take-down, reason code and time only (slice 7). */
  readonly postReviews: Pick<OfferPostReviewRepository, 'latestTakeDownOf'>;
}

/**
 * `own-offer.read` (catalog design 8.2, 9.2a): one of the seller's own Offers with the label of its
 * product. Rule: the key `catalog.own-product.view` and the seller population. An unknown Offer,
 * another seller's and a deleted one answer one byte-identical `offer.not-found`. One read-only
 * unit (ADR-0025). The answer carries the Offer's latest held change (`pendingChange`, slice 2c):
 * its proposed fields, reasons, status and the reviewer's note.
 */
export class OwnOfferRead extends UseCase<OwnOfferReadInput, OwnOfferView, OwnOfferReadFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-read',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferReadInput,
  ): Promise<Result<OwnOfferView, OwnOfferReadFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const parsed = typeof input.offerId === 'string' ? parseId<'Offer'>(input.offerId) : null;
    if (parsed === null || !parsed.ok) return invalid('offerId', 'format');
    const { market } = context;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const offer = await this.deps.offers.findById(market, parsed.value);
        if (offer === null) return ok(null);
        const { sellerId: owner, status, productId } = offer.state;
        if (owner !== sellerId || status === 'deleted') return ok(null);
        const [label] = await this.deps.ownReader.productLabels(market, [productId], locale);
        const sellUnits = await this.deps.ownReader.sellUnitsOf(market, offer.state.id);
        const latest = await this.deps.pendingChanges.findLatestByOffer(market, offer.state.id);
        // A take-down is told only while the Offer is off sale after it: sent back with a first
        // publication on record. A first-publication send-back has none (slice 7).
        const taken =
          status === 'changes-needed' && offer.state.firstPublishedAt !== null
            ? await this.deps.postReviews.latestTakeDownOf(market, offer.state.id)
            : null;
        // A later submit (the resubmit after a take-down) and a new send-back make this a
        // first-style send-back again: the take-down is told only if it came after the last
        // submit (Sajad B1).
        const submitted = offer.state.submittedAt;
        const down =
          taken !== null &&
          (submitted === null || Temporal.Instant.compare(taken.at, submitted) >= 0)
            ? taken
            : null;
        return ok({
          ...offerViewOf(offer, label, { withTags: true }),
          takeDown: down === null ? null : { reasonCode: down.reasonCode, at: down.at.toString() },
          sellUnits,
          pendingChange: latest === null ? null : ownOfferChangeViewOf(latest),
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return read.value === null ? err({ code: 'offer.not-found' }) : ok(read.value);
  }
}
