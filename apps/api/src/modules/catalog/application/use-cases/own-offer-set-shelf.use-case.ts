import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { closedInput, invalid, versionOf } from '../categories/category-editor';
import { sellerOf } from '../own-reads/own-reads.shared';
import type { SellerCategoryStore } from '../ports/seller-category.store';
import { shelfIdOf, type ValidationFailure } from '../seller-categories/seller-category-shared';

export interface OwnOfferSetShelfInput {
  readonly offerId: string;
  readonly body: unknown;
}

export type OwnOfferSetShelfFailure =
  | ValidationFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'offer.not-found' }
  | { readonly code: 'seller-category.not-found' }
  | { readonly code: 'conflict.stale' };

export interface OwnOfferSetShelfDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly shelves: SellerCategoryStore;
  readonly clock: Clock;
}

/**
 * `own-offer.set-shelf` (categories C9a; CAT-52): a seller puts one of their Offers on one of
 * their active shelves, or takes it off (`shelfId: null`). Rule: the key
 * `catalog.own-product.edit`, the seller population, a seller who is approved. The seller is the
 * session's; another seller's or an unknown Offer is `offer.not-found`, a shelf that is not the
 * seller's own and active is `seller-category.not-found` (a shelf on an Offer must belong to that
 * Offer's seller; the composite key backs it). The body names the Offer version the page read.
 * The shelf is not a platform category and changes no tag, badge or revision.
 */
export class OwnOfferSetShelf extends UseCase<
  OwnOfferSetShelfInput,
  { readonly version: number },
  OwnOfferSetShelfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-offer-set-shelf',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnOfferSetShelf');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOfferSetShelfDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferSetShelfInput,
  ): Promise<Result<{ readonly version: number }, OwnOfferSetShelfFailure>> {
    const result = await this.#set(context, input);
    this.#logger.log({
      msg: 'catalog.own-offer-set-shelf',
      code: result.ok ? 'set' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #set(
    context: CallContext,
    input: OwnOfferSetShelfInput,
  ): Promise<Result<{ readonly version: number }, OwnOfferSetShelfFailure>> {
    const { actor } = context;
    const sellerId = sellerOf(context);
    if (sellerId === null || actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const offer = parseId<'Offer'>(input.offerId);
    if (!offer.ok) return err({ code: 'offer.not-found' });
    const body = closedInput(input.body, ['shelfId', 'version']);
    if (!body.ok) return body;
    const version = versionOf(body.value['version'], 'version');
    if (!version.ok) return version;
    const rawShelf = body.value['shelfId'];
    let shelfId: Id<'SellerCategory'> | null = null;
    if (rawShelf !== null) {
      if (rawShelf === undefined) return invalid('shelfId', 'required');
      shelfId = shelfIdOf(rawShelf);
      if (shelfId === null) return err({ code: 'seller-category.not-found' });
    }
    const { market } = context;
    const { deps } = this;
    return deps.unitOfWork.run<{ readonly version: number }, OwnOfferSetShelfFailure>(
      market,
      async () => {
        if (shelfId !== null) {
          const shelf = await deps.shelves.findShelf(market, shelfId);
          if (shelf === null || shelf.sellerId !== sellerId || shelf.status !== 'active') {
            return err({ code: 'seller-category.not-found' } as const);
          }
        }
        const changed = await deps.shelves.setOfferShelf(market, {
          offerId: offer.value,
          sellerId,
          shelfId,
          expectedVersion: version.value,
          actor: {
            kind: 'seller',
            accountId: actor.accountId,
            // No session carries the acting-as marker yet (SEL-08); identity fills it then.
            actingAdminAccountId: null,
          },
          now: deps.clock.now(),
        });
        if (changed === 'offer.not-found' || changed === 'conflict.stale') {
          return err({ code: changed } as const);
        }
        return ok({ version: changed.version });
      },
    );
  }
}
