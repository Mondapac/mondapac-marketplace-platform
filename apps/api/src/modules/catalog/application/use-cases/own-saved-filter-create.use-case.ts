import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { SavedFilterSharedAudit } from '../../domain/audit';
import {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  type SavedFilter,
} from '../../domain/saved-filter';
import { isActingAsSession } from '../acting-as';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { SellerSavedFilterRepository } from '../ports/seller-saved-filter.repository';
import {
  auditListOf,
  canShareOf,
  nameOf,
  visibilityOf,
} from '../saved-filters/saved-filter-shared';
import {
  memberOf,
  ownViewOf,
  sellerListOf,
  type OwnSavedFilterView,
} from '../saved-filters/seller-saved-filter-shared';
import type { AccessProbe } from './saved-filter-share-check.use-case';

export interface OwnSavedFilterCreateInput {
  readonly listKey?: unknown;
  readonly name?: unknown;
  readonly visibility?: unknown;
  readonly payload?: unknown;
}

export type OwnSavedFilterCreateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.acting-as-refused' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'saved-filter.name-taken' }
  | { readonly code: 'saved-filter.limit-reached'; readonly max: number }
  | { readonly code: 'saved-filter.shared-limit-reached'; readonly max: number }
  | ValidationFailure;

export interface OwnSavedFilterCreateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerSavedFilters: SellerSavedFilterRepository;
  readonly ownShareCheck: AccessProbe;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const KEYS = new Set(['listKey', 'name', 'visibility', 'payload']);

/**
 * `own-saved-filter.create` (catalog design 9.2d): saves the tab, search, filters and sort of the
 * seller Products list under a name, for the caller only (`me`) or for every member of the store
 * (`everyone`). Rule: the key `catalog.own-product.view` and the seller population; `everyone` also
 * needs `catalog.own-saved-filter.share`, else `access.denied` and nothing is written. An
 * acting-as session (Login as Seller) is refused: it is the seller's own preference. The payload
 * is read by the list's own closed parser and stored in its canonical form. A member keeps at most
 * {@link MAX_SAVED_FILTERS_PER_OWNER} filters in the store's list and the store has at most
 * {@link MAX_SHARED_SAVED_FILTERS} shared; a name is one per member and, among shared filters, one
 * per store and list, whatever its case. A filter shared with the store is audited (ids and codes
 * only, never the name). The store is the actor's, never the request's. Serializable, so two saves
 * racing at the cap cannot both pass.
 */
export class OwnSavedFilterCreate extends UseCase<
  OwnSavedFilterCreateInput,
  OwnSavedFilterView,
  OwnSavedFilterCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-saved-filter-create',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('OwnSavedFilterCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnSavedFilterCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnSavedFilterCreateInput,
  ): Promise<Result<OwnSavedFilterView, OwnSavedFilterCreateFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.own-saved-filter-create',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: OwnSavedFilterCreateInput,
  ): Promise<Result<OwnSavedFilterView, OwnSavedFilterCreateFailure>> {
    const member = memberOf(context);
    if (member === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('body', 'type');
    }
    for (const key of Object.keys(input)) if (!KEYS.has(key)) return invalid(key, 'unknown');
    const list = sellerListOf(input.listKey);
    if (!list.ok) return list;
    const name = nameOf(input.name);
    if (!name.ok) return name;
    const visibility = visibilityOf(input.visibility);
    if (!visibility.ok) return visibility;
    const payload = list.value.parsePayload(input.payload);
    if (!payload.ok) return payload;

    const canShare = await canShareOf(this.deps.ownShareCheck, context);
    if (!canShare.ok) return canShare;
    if (visibility.value === 'everyone' && !canShare.value) return err({ code: 'access.denied' });

    const { market } = context;
    const { deps } = this;
    const { sellerId } = member;
    const listKey = list.value.key;
    const written = await deps.unitOfWork.run<SavedFilter, OwnSavedFilterCreateFailure>(
      market,
      async () => {
        if (
          (await deps.sellerSavedFilters.countOwnedBy(
            market,
            sellerId,
            listKey,
            member.accountId,
          )) >= MAX_SAVED_FILTERS_PER_OWNER
        ) {
          return err({ code: 'saved-filter.limit-reached', max: MAX_SAVED_FILTERS_PER_OWNER });
        }
        if (
          visibility.value === 'everyone' &&
          (await deps.sellerSavedFilters.countShared(market, sellerId, listKey)) >=
            MAX_SHARED_SAVED_FILTERS
        ) {
          return err({ code: 'saved-filter.shared-limit-reached', max: MAX_SHARED_SAVED_FILTERS });
        }
        const now = deps.clock.now();
        const filter: SavedFilter = {
          id: deps.ids.next<'SavedFilter'>(),
          listKey,
          ownerAccountId: member.accountId,
          sellerId,
          visibility: visibility.value,
          name: name.value,
          payload: payload.value,
          position: await deps.sellerSavedFilters.nextPosition(
            market,
            sellerId,
            listKey,
            member.accountId,
          ),
          createdAt: now,
          updatedAt: now,
        };
        if ((await deps.sellerSavedFilters.add(market, filter)) === 'name-taken') {
          return err({ code: 'saved-filter.name-taken' });
        }
        if (filter.visibility === 'everyone') {
          await deps.audit.record(
            context,
            SavedFilterSharedAudit.entry(filter.id, {
              after: { listKey: auditListOf(filter.listKey), visibility: 'everyone' },
            }),
          );
        }
        return ok(filter);
      },
      { isolation: 'serializable' },
    );
    if (!written.ok) return written;
    return ok(ownViewOf(written.value, member.accountId, canShare.value));
  }
}
