import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellingFactsRepository } from '../ports/selling-facts.repository';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface AiAccessInput {
  readonly sellerId: string;
}

export type AiAccessFailure = SellerIdsRefused | { readonly code: 'sellers.unavailable' };

export interface AiAccessDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellingFacts: SellingFactsRepository;
}

/**
 * `aiAccessOf` (SEL-25; ADR-0019 decision 7), the one query function behind both use cases of the
 * pair: the seller's `ai_enabled` switch in one read-only unit. A missing row (an unknown seller,
 * another Market's seller or a fault) or a read error is `sellers.unavailable`; it is never read as
 * "on". `platform/ai` callers treat any error as off (ADR-0019 R8).
 */
export async function aiAccessFor(
  deps: AiAccessDependencies,
  context: CallContext,
  sellerId: string,
): Promise<Result<boolean, AiAccessFailure>> {
  const ids = parseSellerIds([sellerId]);
  if (!ids.ok) return ids;
  const [id] = [...ids.value] as [Id<'Seller'> | undefined];
  if (id === undefined) return err({ code: 'sellers.unavailable' });
  const { market } = context;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.sellingFacts.aiEnabled(market, id)),
      { readOnly: true },
    );
    if (!read.ok || read.value === null) return err({ code: 'sellers.unavailable' });
    return ok(read.value);
  } catch {
    return err({ code: 'sellers.unavailable' });
  }
}

/** `aiAccessOf` for request actors: rule `anonymous`; its pair is the `system` case. */
export class AiAccess extends UseCase<AiAccessInput, boolean, AiAccessFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.ai-access',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AiAccessDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: AiAccessInput,
  ): Promise<Result<boolean, AiAccessFailure>> {
    return aiAccessFor(this.deps, context, input.sellerId);
  }
}
