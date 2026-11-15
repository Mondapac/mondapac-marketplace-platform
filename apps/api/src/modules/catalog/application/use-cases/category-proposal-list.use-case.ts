import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CATEGORY_PROPOSAL_DECIDE } from '../../contracts/permissions';
import { editorAccountOf } from '../categories/category-editor';
import { parsePage } from '../own-reads/own-reads.shared';
import type { SellerCategoryStore } from '../ports/seller-category.store';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import {
  proposalBodyOf,
  type ProposalBody,
  type ValidationFailure,
} from '../seller-categories/seller-category-shared';

export interface CategoryProposalListAnswer {
  /** Oldest first. `storeName` is null when sellers cannot name the seller. */
  readonly items: readonly (ProposalBody & { readonly storeName: string | null })[];
  /** The id to pass as `afterId` for the next page, or null on the last one. */
  readonly nextAfterId: string | null;
}

export interface CategoryProposalListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly shelves: SellerCategoryStore;
  readonly sellerNames: SellerNamesReader;
}

type Failure =
  ValidationFailure | { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

/**
 * `category-proposal.list` (categories C9a; ux FP8 row 4): the Market's waiting proposals, oldest
 * first, a keyset page of at most 50. Rule: the key `catalog.category-proposal.decide`, the admin
 * population, never an acting-as session. Store names come from `sellerSummaries`; a seller it
 * cannot name shows without one.
 */
export class CategoryProposalList extends UseCase<unknown, CategoryProposalListAnswer, Failure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-proposal-list',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_PROPOSAL_DECIDE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryProposalListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<CategoryProposalListAnswer, Failure>> {
    if (editorAccountOf(context) === null) return err({ code: 'access.denied' });
    const page = parsePage<'CategoryProposal'>(input);
    if (!page.ok) return page;
    const { market } = context;
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await deps.shelves.listPending(market, {
            after: page.value.afterId,
            limit: page.value.limit + 1,
          }),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const rows = read.value.slice(0, page.value.limit);
    const more = read.value.length > page.value.limit;
    const names = await deps.sellerNames.storeNames(context, [
      ...new Set(rows.map((row) => row.sellerId)),
    ]);
    return ok({
      items: rows.map((row) => ({
        ...proposalBodyOf(row),
        storeName: names.get(row.sellerId) ?? null,
      })),
      nextAfterId: more ? (rows.at(-1)?.id ?? null) : null,
    });
  }
}
