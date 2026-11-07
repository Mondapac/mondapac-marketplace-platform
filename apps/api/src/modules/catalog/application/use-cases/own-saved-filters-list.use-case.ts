import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  inTabOrder,
  type SavedFilter,
} from '../../domain/saved-filter';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import type { SellerSavedFilterRepository } from '../ports/seller-saved-filter.repository';
import { canShareOf } from '../saved-filters/saved-filter-shared';
import { SELLER_SAVED_FILTER_LIST_KEYS } from '../saved-filters/seller-saved-filter-lists';
import {
  memberOf,
  ownViewOf,
  sellerListOf,
  type OwnSavedFilterView,
} from '../saved-filters/seller-saved-filter-shared';
import type { AccessProbe } from './saved-filter-share-check.use-case';

// What the controller and DTOs of the routes name in their API documents; an entry point reaches
// the application through use cases only.
export { SELLER_SAVED_FILTER_LIST_KEYS };

export interface OwnSavedFiltersListInput {
  readonly listKey?: unknown;
}

export interface OwnSavedFiltersListOutput {
  readonly items: readonly OwnSavedFilterView[];
  /** Whether the caller may save a filter for the whole store (`catalog.own-saved-filter.share`). */
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
}

export type OwnSavedFiltersListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface OwnSavedFiltersListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerSavedFilters: SellerSavedFilterRepository;
  readonly ownShareCheck: AccessProbe;
}

/**
 * `own-saved-filters.list` (catalog design 9.2d): the saved views of the seller Products list that
 * the caller can use, as tabs after the fixed ones: their own, then the ones other members of the
 * same store shared with everyone, each group oldest first. A filter of another store is never
 * read: the store comes from the actor and goes into the statement. A stored document that no
 * longer reads as the list's own vocabulary is left out. Rule: the key `catalog.own-product.view`
 * and the seller population; the Market comes from the context. One read-only unit.
 */
export class OwnSavedFiltersList extends UseCase<
  OwnSavedFiltersListInput,
  OwnSavedFiltersListOutput,
  OwnSavedFiltersListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-saved-filters-list',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('OwnSavedFiltersList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnSavedFiltersListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnSavedFiltersListInput,
  ): Promise<Result<OwnSavedFiltersListOutput, OwnSavedFiltersListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.own-saved-filters-list',
      code: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: OwnSavedFiltersListInput,
  ): Promise<Result<OwnSavedFiltersListOutput, OwnSavedFiltersListFailure>> {
    const member = memberOf(context);
    if (member === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    for (const key of Object.keys(input)) if (key !== 'listKey') return invalid(key, 'unknown');
    const list = sellerListOf(input.listKey);
    if (!list.ok) return list;
    const canShare = await canShareOf(this.deps.ownShareCheck, context);
    if (!canShare.ok) return canShare;

    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const rows = await this.deps.sellerSavedFilters.visibleTo(
          market,
          member.sellerId,
          list.value.key,
          member.accountId,
        );
        const usable: SavedFilter[] = [];
        for (const filter of inTabOrder(rows, member.accountId)) {
          const payload = list.value.parsePayload(filter.payload);
          if (payload.ok) usable.push({ ...filter, payload: payload.value });
        }
        return ok(usable);
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({
      items: read.value.map((filter) => ownViewOf(filter, member.accountId, canShare.value)),
      canShare: canShare.value,
      limits: { perOwner: MAX_SAVED_FILTERS_PER_OWNER, shared: MAX_SHARED_SAVED_FILTERS },
    });
  }
}
