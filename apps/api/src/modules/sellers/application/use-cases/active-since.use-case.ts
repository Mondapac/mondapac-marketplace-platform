import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellingFactsRepository } from '../ports/selling-facts.repository';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface ActiveSinceInput {
  readonly sellerId: string;
}

export type ActiveSinceFailure = SellerIdsRefused | { readonly code: 'sellers.unavailable' };

export interface ActiveSinceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellingFacts: SellingFactsRepository;
}

/**
 * `activeSinceOf` (promotions T1, the new-seller approval rule), the one query function behind
 * both use cases of the pair: the instant the seller's business file was first approved in the
 * context's Market, in one read-only unit. Null when no revision was ever approved, the seller is
 * unknown or of another Market (byte-identical). A read error is `sellers.unavailable`; the caller
 * treats both as "new" (fail closed). An instant only: no store field, no personal data.
 */
export async function activeSinceFor(
  deps: ActiveSinceDependencies,
  context: CallContext,
  sellerId: string,
): Promise<Result<Temporal.Instant | null, ActiveSinceFailure>> {
  const ids = parseSellerIds([sellerId]);
  if (!ids.ok) return ids;
  const [id] = [...ids.value] as [Id<'Seller'> | undefined];
  if (id === undefined) return err({ code: 'sellers.unavailable' });
  const { market } = context;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.sellingFacts.firstApprovedAt(market, id)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'sellers.unavailable' });
    return ok(read.value);
  } catch {
    return err({ code: 'sellers.unavailable' });
  }
}

/** `activeSinceOf` for request actors: rule `anonymous`; its pair is the `system` case. */
export class ActiveSince extends UseCase<
  ActiveSinceInput,
  Temporal.Instant | null,
  ActiveSinceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.active-since',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ActiveSinceDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ActiveSinceInput,
  ): Promise<Result<Temporal.Instant | null, ActiveSinceFailure>> {
    return activeSinceFor(this.deps, context, input.sellerId);
  }
}
