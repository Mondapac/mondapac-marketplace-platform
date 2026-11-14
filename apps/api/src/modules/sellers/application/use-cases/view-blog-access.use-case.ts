import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import type { BlogAccessRepository } from '../ports/blog-access.repository';

export interface ViewBlogAccessInput {
  readonly sellerId?: unknown;
}

export interface ViewBlogAccessResult {
  readonly enabled: boolean;
  /** When an admin last changed the switch; null when it never changed. */
  readonly changedAt: Temporal.Instant | null;
}

export type ViewBlogAccessFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' };

export interface ViewBlogAccessDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly blogAccess: BlogAccessRepository;
}

/**
 * `sellers.view-blog-access`: the admin read of a seller's blog switch and when it last changed,
 * for the switch on the admin seller page. Rule `permissions [sellers.seller.view]`; admin
 * population only. One read-only unit. An unknown seller and another Market's seller are both
 * `file.not-found`. Changing the switch stays with `sellers.blog-access-set`.
 */
export class ViewBlogAccessUseCase extends UseCase<
  ViewBlogAccessInput,
  ViewBlogAccessResult,
  ViewBlogAccessFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.view-blog-access',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewBlogAccessDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewBlogAccessInput,
  ): Promise<Result<ViewBlogAccessResult, ViewBlogAccessFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const seller =
      typeof (input ?? {}).sellerId === 'string'
        ? parseId<'Seller'>(input.sellerId as string)
        : null;
    if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
    const sellerId = seller.value;
    return this.deps.unitOfWork.run<ViewBlogAccessResult, ViewBlogAccessFailure>(
      market,
      async () => {
        const view = await this.deps.blogAccess.read(market, sellerId);
        return view === null ? err({ code: 'file.not-found' }) : ok(view);
      },
      { readOnly: true },
    );
  }
}
