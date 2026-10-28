import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellingFactsRepository } from '../ports/selling-facts.repository';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface BlogAccessInput {
  readonly sellerId: string;
}

export type BlogAccessFailure = SellerIdsRefused | { readonly code: 'sellers.unavailable' };

export interface BlogAccessDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellingFacts: SellingFactsRepository;
}

/**
 * `blogAccessOf` (blog package 1), the one query function behind both use cases of the pair: the
 * seller's `blog_enabled` switch in one read-only unit. A missing row (an unknown seller, another
 * Market's seller or a fault) or a read error is `sellers.unavailable`; the caller refuses and
 * never reads it as "on".
 */
export async function blogAccessFor(
  deps: BlogAccessDependencies,
  context: CallContext,
  sellerId: string,
): Promise<Result<boolean, BlogAccessFailure>> {
  const ids = parseSellerIds([sellerId]);
  if (!ids.ok) return ids;
  const [id] = [...ids.value] as [Id<'Seller'> | undefined];
  if (id === undefined) return err({ code: 'sellers.unavailable' });
  const { market } = context;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.sellingFacts.blogEnabled(market, id)),
      { readOnly: true },
    );
    if (!read.ok || read.value === null) return err({ code: 'sellers.unavailable' });
    return ok(read.value);
  } catch {
    return err({ code: 'sellers.unavailable' });
  }
}

/** `blogAccessOf` for request actors: rule `anonymous`; its pair is the `system` case. */
export class BlogAccess extends UseCase<BlogAccessInput, boolean, BlogAccessFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.blog-access',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlogAccessDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: BlogAccessInput,
  ): Promise<Result<boolean, BlogAccessFailure>> {
    return blogAccessFor(this.deps, context, input.sellerId);
  }
}
