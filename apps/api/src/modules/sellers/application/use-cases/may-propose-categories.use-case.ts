import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellingFactsRepository } from '../ports/selling-facts.repository';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface MayProposeCategoriesInput {
  readonly sellerId: string;
}

export type MayProposeCategoriesFailure =
  SellerIdsRefused | { readonly code: 'sellers.unavailable' };

export interface MayProposeCategoriesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellingFacts: SellingFactsRepository;
}

/**
 * `mayProposeCategories` (sellers design 7.1; SEL-26), the one query function behind both use
 * cases of the pair: the seller's `category_proposals_allowed` switch in one read-only unit. A
 * missing row (an unknown seller, another Market's seller or a fault) or a read error is
 * `sellers.unavailable`; the caller (`catalog`, at every proposal command) refuses and never reads
 * it as "allowed".
 */
export async function mayProposeCategoriesFor(
  deps: MayProposeCategoriesDependencies,
  context: CallContext,
  sellerId: string,
): Promise<Result<boolean, MayProposeCategoriesFailure>> {
  const ids = parseSellerIds([sellerId]);
  if (!ids.ok) return ids;
  const [id] = [...ids.value] as [Id<'Seller'> | undefined];
  if (id === undefined) return err({ code: 'sellers.unavailable' });
  const { market } = context;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.sellingFacts.categoryProposalsAllowed(market, id)),
      { readOnly: true },
    );
    if (!read.ok || read.value === null) return err({ code: 'sellers.unavailable' });
    return ok(read.value);
  } catch {
    return err({ code: 'sellers.unavailable' });
  }
}

/** `mayProposeCategories` for request actors: rule `anonymous`; its pair is the `system` case. */
export class MayProposeCategories extends UseCase<
  MayProposeCategoriesInput,
  boolean,
  MayProposeCategoriesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.may-propose-categories',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MayProposeCategoriesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: MayProposeCategoriesInput,
  ): Promise<Result<boolean, MayProposeCategoriesFailure>> {
    return mayProposeCategoriesFor(this.deps, context, input.sellerId);
  }
}
