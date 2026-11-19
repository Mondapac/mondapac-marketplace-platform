import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { SavedFilterChangedAudit } from '../../domain/audit';
import {
  MAX_SHARED_SAVED_FILTERS,
  isVisibleTo,
  mayManage,
  type SavedFilter,
} from '../../domain/saved-filter';
import { isActingAsSession } from '../acting-as';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { SellerSavedFilterRepository } from '../ports/seller-saved-filter.repository';
import {
  auditListOf,
  canShareOf,
  filterIdOf,
  nameOf,
  visibilityOf,
} from '../saved-filters/saved-filter-shared';
import {
  memberOf,
  ownViewOf,
  type OwnSavedFilterView,
} from '../saved-filters/seller-saved-filter-shared';
import type { AccessProbe } from './saved-filter-share-check.use-case';

export interface OwnSavedFilterUpdateInput {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly visibility?: unknown;
}

export type OwnSavedFilterUpdateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.acting-as-refused' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'saved-filter.not-found' }
  | { readonly code: 'saved-filter.name-taken' }
  | { readonly code: 'saved-filter.shared-limit-reached'; readonly max: number }
  | ValidationFailure;

export interface OwnSavedFilterUpdateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerSavedFilters: SellerSavedFilterRepository;
  readonly ownShareCheck: AccessProbe;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

const KEYS = new Set(['id', 'name', 'visibility']);

/**
 * `own-saved-filter.update` (catalog design 9.2d): renames a saved filter of the seller Products
 * list and sets who can use it (both given; the document never changes after saving: save a new
 * filter). Who may: the owner, always; and, for a filter shared with the store, any member who
 * holds `catalog.own-saved-filter.share`. Making a filter `everyone` needs that key for anybody,
 * the owner included. The filter is looked up in the actor's store only: a filter of another store,
 * another member's `me` filter and an unknown id are the same `saved-filter.not-found`; a visible
 * filter the caller may not manage is `access.denied`. An acting-as session is refused. Nothing is
 * written when the name and visibility are the same. A change to or from `everyone` is audited
 * (ids and codes only). Serializable, so the shared cap holds under a race.
 */
export class OwnSavedFilterUpdate extends UseCase<
  OwnSavedFilterUpdateInput,
  OwnSavedFilterView,
  OwnSavedFilterUpdateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-saved-filter-update',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('OwnSavedFilterUpdate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnSavedFilterUpdateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnSavedFilterUpdateInput,
  ): Promise<Result<OwnSavedFilterView, OwnSavedFilterUpdateFailure>> {
    const result = await this.#update(context, input);
    this.#logger.log({
      msg: 'catalog.own-saved-filter-update',
      code: result.ok ? 'updated' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #update(
    context: CallContext,
    input: OwnSavedFilterUpdateInput,
  ): Promise<Result<OwnSavedFilterView, OwnSavedFilterUpdateFailure>> {
    const member = memberOf(context);
    if (member === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
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

    const canShare = await canShareOf(this.deps.ownShareCheck, context);
    if (!canShare.ok) return canShare;

    const { market } = context;
    const { deps } = this;
    const written = await deps.unitOfWork.run<SavedFilter, OwnSavedFilterUpdateFailure>(
      market,
      async () => {
        const found = await deps.sellerSavedFilters.find(market, member.sellerId, id);
        if (found === null || !isVisibleTo(found, member.accountId)) {
          return err({ code: 'saved-filter.not-found' });
        }
        if (!mayManage(found, member.accountId, canShare.value)) {
          return err({ code: 'access.denied' });
        }
        const renamed = found.name !== name.value;
        const moved = found.visibility !== visibility.value;
        if (moved && visibility.value === 'everyone') {
          if (!canShare.value) return err({ code: 'access.denied' });
          if (
            (await deps.sellerSavedFilters.countShared(market, member.sellerId, found.listKey)) >=
            MAX_SHARED_SAVED_FILTERS
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
        const outcome = await deps.sellerSavedFilters.change(market, changed);
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
                ownedByActor: changed.ownerAccountId === member.accountId,
              },
            }),
          );
        }
        return ok(changed);
      },
      { isolation: 'serializable' },
    );
    if (!written.ok) return written;
    return ok(ownViewOf(written.value, member.accountId, canShare.value));
  }
}
