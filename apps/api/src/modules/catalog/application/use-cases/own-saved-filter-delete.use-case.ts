import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { SavedFilterRemovedAudit } from '../../domain/audit';
import { isVisibleTo, mayManage } from '../../domain/saved-filter';
import { isActingAsSession } from '../acting-as';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { SellerSavedFilterRepository } from '../ports/seller-saved-filter.repository';
import { auditListOf, canShareOf, filterIdOf } from '../saved-filters/saved-filter-shared';
import { memberOf } from '../saved-filters/seller-saved-filter-shared';
import type { AccessProbe } from './saved-filter-share-check.use-case';

export interface OwnSavedFilterDeleteInput {
  readonly id?: unknown;
}

export interface OwnSavedFilterDeleteOutput {
  readonly id: string;
}

export type OwnSavedFilterDeleteFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.acting-as-refused' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'saved-filter.not-found' }
  | ValidationFailure;

export interface OwnSavedFilterDeleteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerSavedFilters: SellerSavedFilterRepository;
  readonly ownShareCheck: AccessProbe;
  readonly audit: AuditWriter;
}

/**
 * `own-saved-filter.delete` (catalog design 9.2d): deletes a saved filter of the seller Products
 * list for good (a preference, not a record to keep). Who may: the owner, always, and, for a
 * filter shared with the store, any member who holds `catalog.own-saved-filter.share`. The filter
 * is looked up in the actor's store only: another store's filter, another member's `me` filter and
 * an unknown id are the same `saved-filter.not-found`; a visible filter the caller may not manage
 * is `access.denied`. An acting-as session is refused. Deleting a filter shared with the store is
 * audited (ids and codes only).
 */
export class OwnSavedFilterDelete extends UseCase<
  OwnSavedFilterDeleteInput,
  OwnSavedFilterDeleteOutput,
  OwnSavedFilterDeleteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-saved-filter-delete',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('OwnSavedFilterDelete');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnSavedFilterDeleteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnSavedFilterDeleteInput,
  ): Promise<Result<OwnSavedFilterDeleteOutput, OwnSavedFilterDeleteFailure>> {
    const result = await this.#delete(context, input);
    this.#logger.log({
      msg: 'catalog.own-saved-filter-delete',
      code: result.ok ? 'deleted' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #delete(
    context: CallContext,
    input: OwnSavedFilterDeleteInput,
  ): Promise<Result<OwnSavedFilterDeleteOutput, OwnSavedFilterDeleteFailure>> {
    const member = memberOf(context);
    if (member === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('body', 'type');
    }
    for (const key of Object.keys(input)) if (key !== 'id') return invalid(key, 'unknown');
    const id = filterIdOf(input.id);
    if (id === null) return err({ code: 'saved-filter.not-found' });
    const canShare = await canShareOf(this.deps.ownShareCheck, context);
    if (!canShare.ok) return canShare;

    const { market } = context;
    const { deps } = this;
    return deps.unitOfWork.run<OwnSavedFilterDeleteOutput, OwnSavedFilterDeleteFailure>(
      market,
      async () => {
        const found = await deps.sellerSavedFilters.find(market, member.sellerId, id);
        if (found === null || !isVisibleTo(found, member.accountId)) {
          return err({ code: 'saved-filter.not-found' });
        }
        if (!mayManage(found, member.accountId, canShare.value)) {
          return err({ code: 'access.denied' });
        }
        if (!(await deps.sellerSavedFilters.remove(market, member.sellerId, id))) {
          return err({ code: 'saved-filter.not-found' });
        }
        if (found.visibility === 'everyone') {
          await deps.audit.record(
            context,
            SavedFilterRemovedAudit.entry(id, {
              before: { listKey: auditListOf(found.listKey), visibility: 'everyone' },
              after: { ownedByActor: found.ownerAccountId === member.accountId },
            }),
          );
        }
        return ok({ id });
      },
    );
  }
}
