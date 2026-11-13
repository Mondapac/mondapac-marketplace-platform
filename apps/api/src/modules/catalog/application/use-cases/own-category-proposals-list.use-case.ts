import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_CATEGORY_PROPOSE } from '../../contracts/permissions';
import { sellerOf } from '../own-reads/own-reads.shared';
import type {
  CategoryProposalCapability,
  CategoryProposalPolicy,
} from '../ports/category-proposal-capability';
import type { SellerCategoryStore } from '../ports/seller-category.store';
import {
  proposalBodyOf,
  shelfBodyOf,
  type ProposalBody,
  type ShelfBody,
} from '../seller-categories/seller-category-shared';

export interface OwnCategoryProposalsAnswer {
  /** Whether `sellers.mayProposeCategories` answers yes now: the panel shows the form only then. */
  readonly canPropose: boolean;
  readonly maxPending: number;
  /** Newest first, at most 50. */
  readonly proposals: readonly ProposalBody[];
  /** Every shelf of the seller, active first. */
  readonly shelves: readonly ShelfBody[];
}

export interface OwnCategoryProposalsListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly shelves: SellerCategoryStore;
  readonly capability: CategoryProposalCapability;
  readonly proposalPolicy: CategoryProposalPolicy;
}

const LIMIT = 50;

/**
 * `own-category-proposals.list` (categories C9a): the seller's own proposals and shelves, for the
 * "Suggest a category" page. Rule: the key `catalog.own-category.propose`, the seller population;
 * the seller is the session's. A read-only unit; `mayProposeCategories` is asked outside it.
 */
export class OwnCategoryProposalsList extends UseCase<
  Record<string, never>,
  OwnCategoryProposalsAnswer,
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-category-proposals-list',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_CATEGORY_PROPOSE.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnCategoryProposalsListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<
    Result<
      OwnCategoryProposalsAnswer,
      { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' }
    >
  > {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    let maxPending: number;
    try {
      maxPending = deps.proposalPolicy.maxPending(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const canPropose = await deps.capability.allows(context, sellerId);
    const read = await deps.unitOfWork.run(
      market,
      async () =>
        ok({
          proposals: await deps.shelves.listOfSeller(market, sellerId, LIMIT),
          shelves: await deps.shelves.shelvesOfSeller(market, sellerId),
        }),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({
      canPropose,
      maxPending,
      proposals: read.value.proposals.map(proposalBodyOf),
      shelves: read.value.shelves.map(shelfBodyOf),
    });
  }
}
