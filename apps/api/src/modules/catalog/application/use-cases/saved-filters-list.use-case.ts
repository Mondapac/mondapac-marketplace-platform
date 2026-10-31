import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  inTabOrder,
  type SavedFilter,
} from '../../domain/saved-filter';
import { ADMIN_PRODUCT_SORTS, type AdminProductsReader } from '../ports/admin-products.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { SavedFilterRepository } from '../ports/saved-filter.repository';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import {
  SAVED_FILTER_LIST_KEYS,
  type ProductsFilterPayload,
} from '../saved-filters/saved-filter-lists';
import {
  adminOf,
  canShareOf,
  listOf,
  viewOf,
  type SavedFilterView,
} from '../saved-filters/saved-filter-shared';
import type { AccessProbe } from './saved-filter-share-check.use-case';

// What the controller and DTOs of the routes name in their API documents; an entry point reaches
// the application through use cases only.
export { ADMIN_PRODUCT_SORTS, SAVED_FILTER_LIST_KEYS };

/** Saved views whose product count is read with the list: the first ones, in tab order. */
export const COUNTED_SAVED_FILTERS = 12;

export interface SavedFiltersListInput {
  readonly listKey?: unknown;
}

export interface SavedFiltersListOutput {
  readonly items: readonly SavedFilterView[];
  /** Whether the caller may save a filter for everyone (the key `catalog.saved-filter.share`). */
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
}

export type SavedFiltersListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface SavedFiltersListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly savedFilters: SavedFilterRepository;
  readonly shareCheck: AccessProbe;
  readonly adminProductsReader: AdminProductsReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `saved-filters.list` (catalog design 9.2d): the saved views of one admin list that the caller
 * can use, as tabs after the fixed ones: their own, then the ones shared with everyone, each group
 * oldest first. Each carries its stored document, whether the caller owns it, whether they may
 * manage it, and, for the first {@link COUNTED_SAVED_FILTERS}, the number of products it matches now
 * (one count each; the rest answer `count: null` rather than cost a query per tab). A stored
 * document that no longer reads as the list's own vocabulary is left out. Rule: the key
 * `catalog.product.view` (the first list's key; the registry test fails for a list with another)
 * and the admin population; the Market comes from the context.
 */
export class SavedFiltersList extends UseCase<
  SavedFiltersListInput,
  SavedFiltersListOutput,
  SavedFiltersListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.saved-filters-list',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  readonly #logger = new Logger('SavedFiltersList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFiltersListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SavedFiltersListInput,
  ): Promise<Result<SavedFiltersListOutput, SavedFiltersListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.saved-filters-list',
      code: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: SavedFiltersListInput,
  ): Promise<Result<SavedFiltersListOutput, SavedFiltersListFailure>> {
    const admin = adminOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    for (const key of Object.keys(input)) if (key !== 'listKey') return invalid(key, 'unknown');
    const list = listOf(input.listKey);
    if (!list.ok) return list;
    const { market } = context;
    const { deps } = this;
    let locale: string;
    try {
      locale = deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const canShare = await canShareOf(deps.shareCheck, context);
    if (!canShare.ok) return canShare;

    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const rows = await deps.savedFilters.visibleTo(market, list.value.key, admin.accountId);
        const usable: { filter: SavedFilter; payload: ProductsFilterPayload }[] = [];
        for (const filter of inTabOrder(rows, admin.accountId)) {
          const payload = list.value.parsePayload(filter.payload);
          if (payload.ok) usable.push({ filter, payload: payload.value });
        }
        const counted = usable
          .slice(0, COUNTED_SAVED_FILTERS)
          .map((entry) => list.value.countFilter(entry.payload, locale));
        const counts = new Map<number, number>();
        const wanted = counted.flatMap((filter, index) =>
          filter === null ? [] : [{ filter, index }],
        );
        if (wanted.length > 0) {
          const numbers = await deps.adminProductsReader.counts(
            market,
            wanted.map((entry) => entry.filter),
          );
          wanted.forEach((entry, at) => counts.set(entry.index, numbers[at] ?? 0));
        }
        return ok(usable.map((entry, index) => ({ ...entry, count: counts.get(index) ?? null })));
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({
      items: read.value.map((entry) =>
        viewOf(
          { ...entry.filter, payload: entry.payload },
          admin.accountId,
          canShare.value,
          entry.count,
        ),
      ),
      canShare: canShare.value,
      limits: { perOwner: MAX_SAVED_FILTERS_PER_OWNER, shared: MAX_SHARED_SAVED_FILTERS },
    });
  }
}
