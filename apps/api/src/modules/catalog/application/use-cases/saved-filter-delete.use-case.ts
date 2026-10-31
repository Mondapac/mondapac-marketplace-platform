import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SavedFilterRemovedAudit } from '../../domain/audit';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import { isVisibleTo, mayManage } from '../../domain/saved-filter';
import type { SavedFilterRepository } from '../ports/saved-filter.repository';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import { adminOf, auditListOf, canShareOf, filterIdOf } from '../saved-filters/saved-filter-shared';
import type { AccessProbe } from './saved-filter-share-check.use-case';

export interface SavedFilterDeleteInput {
  readonly id?: unknown;
}

export interface SavedFilterDeleteOutput {
  readonly id: string;
}

export type SavedFilterDeleteFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'saved-filter.not-found' }
  | ValidationFailure;

export interface SavedFilterDeleteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly savedFilters: SavedFilterRepository;
  readonly shareCheck: AccessProbe;
  readonly audit: AuditWriter;
}

/**
 * `saved-filter.delete` (catalog design 9.2d): deletes a saved filter for good (it is a
 * preference, not a record to keep). Who may: the owner, always, and, for a filter shared with
 * everyone, any admin who holds `catalog.saved-filter.share`. Another admin's `me` filter is not
 * visible: `saved-filter.not-found`, as for an unknown id; a visible filter the caller may not
 * manage is `access.denied`. Deleting a filter that is already gone answers `not-found` (the
 * caller's list is stale). Deleting a filter shared with everyone is audited (ids and codes only).
 */
export class SavedFilterDelete extends UseCase<
  SavedFilterDeleteInput,
  SavedFilterDeleteOutput,
  SavedFilterDeleteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.saved-filter-delete',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  readonly #logger = new Logger('SavedFilterDelete');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFilterDeleteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SavedFilterDeleteInput,
  ): Promise<Result<SavedFilterDeleteOutput, SavedFilterDeleteFailure>> {
    const result = await this.#delete(context, input);
    this.#logger.log({
      msg: 'catalog.saved-filter-delete',
      code: result.ok ? 'deleted' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #delete(
    context: CallContext,
    input: SavedFilterDeleteInput,
  ): Promise<Result<SavedFilterDeleteOutput, SavedFilterDeleteFailure>> {
    const admin = adminOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('body', 'type');
    }
    for (const key of Object.keys(input)) if (key !== 'id') return invalid(key, 'unknown');
    const id = filterIdOf(input.id);
    if (id === null) return err({ code: 'saved-filter.not-found' });
    const canShare = await canShareOf(this.deps.shareCheck, context);
    if (!canShare.ok) return canShare;

    const { market } = context;
    const { deps } = this;
    return deps.unitOfWork.run<SavedFilterDeleteOutput, SavedFilterDeleteFailure>(
      market,
      async () => {
        const found = await deps.savedFilters.find(market, id);
        if (found === null || !isVisibleTo(found, admin.accountId)) {
          return err({ code: 'saved-filter.not-found' });
        }
        if (!mayManage(found, admin.accountId, canShare.value))
          return err({ code: 'access.denied' });
        if (!(await deps.savedFilters.remove(market, id))) {
          return err({ code: 'saved-filter.not-found' });
        }
        if (found.visibility === 'everyone') {
          await deps.audit.record(
            context,
            SavedFilterRemovedAudit.entry(id, {
              before: { listKey: auditListOf(found.listKey), visibility: 'everyone' },
              after: { ownedByActor: found.ownerAccountId === admin.accountId },
            }),
          );
        }
        return ok({ id });
      },
    );
  }
}
