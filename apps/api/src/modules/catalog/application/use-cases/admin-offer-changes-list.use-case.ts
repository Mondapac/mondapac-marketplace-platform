import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import {
  offerChangeViewOf,
  type ChangeValidationFailure,
  type OfferChangeView,
} from '../offer-change-view';
import type { OfferPendingChangeRepository } from '../ports/offer-pending-change.repository';

export interface AdminOfferChangesListInput {
  /** The `nextAfterId` of the previous page. */
  readonly afterId?: unknown;
  /** 1 to 50, default 25. */
  readonly limit?: unknown;
}

export interface AdminOfferChangesListOutput {
  readonly items: readonly (OfferChangeView & { readonly sellerId: string })[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
}

export type AdminOfferChangesListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | ChangeValidationFailure;

export interface AdminOfferChangesListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly pendingChanges: OfferPendingChangeRepository;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

/**
 * `admin-offer-changes.list` (risk-based Offer approval, slice 2c): the held changes of live
 * Offers that wait for a decision, oldest submit first, keyset-paged on (submit instant, id); each
 * with its proposed fields and the policy's reasons. Rule: the key `catalog.product.view` and the
 * admin population, as the review queue. Minimal: the queue's super list arrives with slice 5.
 * One read-only unit (ADR-0025). A decided change still anchors the page it ended.
 */
export class AdminOfferChangesList extends UseCase<
  AdminOfferChangesListInput,
  AdminOfferChangesListOutput,
  AdminOfferChangesListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-offer-changes-list',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOfferChangesListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminOfferChangesListInput,
  ): Promise<Result<AdminOfferChangesListOutput, AdminOfferChangesListFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const invalid = (path: string, code: string) =>
      err({ code: 'validation.failed', fields: [{ path, code }] } as const);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    for (const key of Object.keys(input)) {
      if (key !== 'afterId' && key !== 'limit') return invalid(key, 'unknown');
    }
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return invalid('limit', 'range');
    }
    let afterId = null;
    if (input.afterId !== undefined) {
      const parsed =
        typeof input.afterId === 'string' ? parseId<'OfferPendingChange'>(input.afterId) : null;
      if (parsed === null || !parsed.ok) return invalid('afterId', 'format');
      afterId = parsed.value;
    }
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        let after = null;
        if (afterId !== null) {
          const anchor = await deps.pendingChanges.findById(market, afterId);
          if (anchor === null) return ok(null);
          after = { submittedAt: anchor.state.submittedAt, id: anchor.state.id };
        }
        // One extra row tells whether a next page exists.
        return ok(await deps.pendingChanges.listPending(market, { after, limit: limit + 1 }));
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return invalid('afterId', 'unknown');
    const rows = read.value.slice(0, limit);
    return ok({
      items: rows.map((change) => ({
        ...offerChangeViewOf(change),
        sellerId: change.state.sellerId,
      })),
      nextAfterId: read.value.length > limit ? (rows[rows.length - 1]?.state.id ?? null) : null,
    });
  }
}
