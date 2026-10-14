import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellingFactsRepository } from '../ports/selling-facts.repository';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface AllowedProductTypesInput {
  readonly sellerId: string;
}

/** Every product type, or the listed type codes (SEL-12). */
export type AllowedProductTypesAnswer = 'all' | ReadonlySet<string>;

export type AllowedProductTypesFailure =
  SellerIdsRefused | { readonly code: 'sellers.unavailable' };

export interface AllowedProductTypesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellingFacts: SellingFactsRepository;
}

/**
 * `allowedProductTypesOf` (sellers design 7.1; SEL-12), the one query function behind both use
 * cases of the pair: the seller's `all_product_types_allowed` setting (data design 3.9) in one
 * read-only unit. Slice 9 answers `all` while the setting is on, and that is every seller: the
 * creating handler writes `true` and no use case changes it before slice 14
 * (ADR-0031 decision 4a, permissive interim). With the setting off the listed codes live in
 * `seller_allowed_product_types`, which slice 14 builds; until then the answer is the empty set
 * (fail closed, nothing allowed). A missing row (an unknown seller, another Market's seller or a
 * fault) or a read error is `sellers.unavailable`; the caller refuses, never reads it as allowed.
 */
export async function allowedProductTypesFor(
  deps: AllowedProductTypesDependencies,
  context: CallContext,
  sellerId: string,
): Promise<Result<AllowedProductTypesAnswer, AllowedProductTypesFailure>> {
  const ids = parseSellerIds([sellerId]);
  if (!ids.ok) return ids;
  const [id] = [...ids.value] as [Id<'Seller'> | undefined];
  if (id === undefined) return err({ code: 'sellers.unavailable' });
  const { market } = context;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.sellingFacts.allowedProductTypes(market, id)),
      { readOnly: true },
    );
    if (!read.ok || read.value === null) return err({ code: 'sellers.unavailable' });
    return ok(read.value === 'all' ? 'all' : new Set<string>());
  } catch {
    return err({ code: 'sellers.unavailable' });
  }
}

/** `allowedProductTypesOf` for request actors: rule `anonymous`; its pair is the `system` case. */
export class AllowedProductTypes extends UseCase<
  AllowedProductTypesInput,
  AllowedProductTypesAnswer,
  AllowedProductTypesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.allowed-product-types',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AllowedProductTypesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: AllowedProductTypesInput,
  ): Promise<Result<AllowedProductTypesAnswer, AllowedProductTypesFailure>> {
    return allowedProductTypesFor(this.deps, context, input.sellerId);
  }
}
