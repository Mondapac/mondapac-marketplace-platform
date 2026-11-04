import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SavedFilterChangedAudit } from '../../domain/audit';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import {
  MAX_SHARED_SAVED_FILTERS,
  isVisibleTo,
  mayManage,
  type SavedFilter,
} from '../../domain/saved-filter';
import type { SavedFilterRepository } from '../ports/saved-filter.repository';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import {
  adminOf,
  auditListOf,
  canShareOf,
  filterIdOf,
  nameOf,
  viewOf,
  visibilityOf,
  type SavedFilterView,
} from '../saved-filters/saved-filter-shared';
import type { AccessProbe } from './saved-filter-share-check.use-case';

export interface SavedFilterUpdateInput {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly visibility?: unknown;
}

export type SavedFilterUpdateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'saved-filter.not-found' }
  | { readonly code: 'saved-filter.name-taken' }
  | { readonly code: 'saved-filter.shared-limit-reached'; readonly max: number }
  | ValidationFailure;

export interface SavedFilterUpdateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly savedFilters: SavedFilterRepository;
  readonly shareCheck: AccessProbe;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

const KEYS = new Set(['id', 'name', 'visibility']);

/**
 * `saved-filter.update` (catalog design 9.2d): renames a saved filter and sets who can use it
 * (both given; the tab, search, filters and sort never change after saving: save a new filter).
 * Who may: the owner, always (their own preference, whatever their role is now); and, for a
 * filter shared with everyone, any admin who holds `catalog.saved-filter.share`. Making a filter
 * `everyone` needs that key for anybody, the owner included. Another admin's `me` filter is not
 * visible, so it is `saved-filter.not-found`, the same answer as an unknown id; a visible filter
 * the caller may not manage is `access.denied`. Nothing changes (and nothing is written) when the
 * name and visibility are the same. A change to or from `everyone` is audited (ids and codes
 * only). Serializable, so the shared cap holds under a race.
 */
export class SavedFilterUpdate extends UseCase<
  SavedFilterUpdateInput,
  SavedFilterView,
  SavedFilterUpdateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.saved-filter-update',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  readonly #logger = new Logger('SavedFilterUpdate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFilterUpdateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SavedFilterUpdateInput,
  ): Promise<Result<SavedFilterView, SavedFilterUpdateFailure>> {
    const result = await this.#update(context, input);
    this.#logger.log({
      msg: 'catalog.saved-filter-update',
      code: result.ok ? 'updated' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #update(
    context: CallContext,
    input: SavedFilterUpdateInput,
  ): Promise<Result<SavedFilterView, SavedFilterUpdateFailure>> {
    const admin = adminOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('body', 'type');
    }
    for (const key of Object.keys(input)) if (!KEYS.has(key)) return invalid(key, 'unknown');
    const name = nameOf(input.name);
    if (!name.ok) return name;
    const visibility = visibilityOf(input.visibility);
    if (!visibility.ok) return visibility;
    const id = filterIdOf(input.id);
    if (id === null) return err({ code: 'saved-filter.not-found' });

    const canShare = await canShareOf(this.deps.shareCheck, context);
    if (!canShare.ok) return canShare;

    const { market } = context;
    const { deps } = this;
    const written = await deps.unitOfWork.run<SavedFilter, SavedFilterUpdateFailure>(
      market,
      async () => {
        const found = await deps.savedFilters.find(market, id);
        if (found === null || !isVisibleTo(found, admin.accountId)) {
          return err({ code: 'saved-filter.not-found' });
        }
        if (!mayManage(found, admin.accountId, canShare.value))
          return err({ code: 'access.denied' });
        const renamed = found.name !== name.value;
        const moved = found.visibility !== visibility.value;
        if (moved && visibility.value === 'everyone') {
          if (!canShare.value) return err({ code: 'access.denied' });
          if (
            (await deps.savedFilters.countShared(market, found.listKey)) >= MAX_SHARED_SAVED_FILTERS
          ) {
            return err({
              code: 'saved-filter.shared-limit-reached',
              max: MAX_SHARED_SAVED_FILTERS,
            });
          }
        }
        if (!renamed && !moved) return ok(found);
        const changed: SavedFilter = {
          ...found,
          name: name.value,
          visibility: visibility.value,
          updatedAt: deps.clock.now(),
        };
        const outcome = await deps.savedFilters.change(market, changed);
        if (outcome === 'gone') return err({ code: 'saved-filter.not-found' });
        if (outcome === 'name-taken') return err({ code: 'saved-filter.name-taken' });
        if (found.visibility === 'everyone' || changed.visibility === 'everyone') {
          await deps.audit.record(
            context,
            SavedFilterChangedAudit.entry(changed.id, {
              before: { visibility: found.visibility },
              after: {
                listKey: auditListOf(changed.listKey),
                visibility: changed.visibility,
                renamed,
                ownedByActor: changed.ownerAccountId === admin.accountId,
              },
            }),
          );
        }
        return ok(changed);
      },
      { isolation: 'serializable' },
    );
    if (!written.ok) return written;
    return ok(viewOf(written.value, admin.accountId, canShare.value, null));
  }
}
