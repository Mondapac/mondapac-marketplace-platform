import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  heldKeys,
  listPage,
  pageWindow,
  rowActions,
  type ListPagingMode,
  type PermissionProbe,
  type RowActionRule,
} from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BRAND_EDIT, CATALOG_BRAND_READ } from '../../contracts/permissions';
import type { BrandState } from '../../domain/brand';
import {
  BRAND_FILTER_KEYS,
  BRAND_PAGE_DEFAULT,
  BRAND_PAGE_MAX,
  brandIdOf,
  brandListFilterOf,
  closedInput,
  viewOf,
  type BrandView,
  type ValidationFailure,
} from '../brands/brand-views';
import { readCatalogListInput } from '../lists/catalog-list-input';
import { BRAND_SORTS, type BrandReader } from '../ports/brand.reader';

/** The highest page number: 100 pages of 100 stay within the paged rows cap. */
export const BRAND_MAX_PAGE = 100;

/**
 * What each row action needs (the plan's table, row 8): `edit`, `merge` and `deactivate` (the
 * archive route) all decide with `catalog.brand.edit`; an archived brand cannot be edited; a merge takes an active
 * brand, a deactivate any brand not archived yet.
 */
export const BRAND_ACTION_RULES: readonly RowActionRule<Pick<BrandState, 'status'>>[] = [
  {
    id: 'edit',
    permission: CATALOG_BRAND_EDIT.key,
    when: (row) => row.status !== 'archived',
  },
  { id: 'merge', permission: CATALOG_BRAND_EDIT.key, when: (row) => row.status === 'active' },
  {
    id: 'deactivate',
    permission: CATALOG_BRAND_EDIT.key,
    when: (row) => row.status !== 'archived',
  },
];

export interface BrandListInput {
  readonly status?: unknown;
  /** ISO 3166-1 alpha-2 (uppercase), exact match. */
  readonly originCountry?: unknown;
  /** ISO 8601 instant with an offset; created at or after it. */
  readonly createdFrom?: unknown;
  /** ISO 8601 instant with an offset; created before it. */
  readonly createdTo?: unknown;
  /** The search text; `search` is the older name of it. */
  readonly q?: unknown;
  readonly search?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly paging?: unknown;
}

export interface BrandListItem extends BrandView {
  /** The row actions of the Actions menu the caller may run: edit, merge, deactivate. */
  readonly actions: readonly string[];
}

export interface BrandListOutput {
  readonly items: readonly BrandListItem[];
  /** The `afterId` of the next page of the cursor read; null on the last page and on a page read. */
  readonly nextAfterId: string | null;
  /** Brands matching over all pages; null in `prev-next` mode and on a cursor read. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
}

interface BrandPageRead {
  readonly rows: readonly BrandState[];
  readonly nextAfterId: string | null;
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
}

export type BrandListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface BrandListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brandReader: BrandReader;
  readonly brandEditProbe: PermissionProbe;
}

/**
 * `brand.list` (catalog brand package, super list 8): the brands for the admin panel, filtered by
 * status, origin country, creation time (`createdFrom` inclusive, `createdTo` exclusive; see
 * {@link brandListFilterOf}) and by a search text that matches the name, the slug or an alias, read by page number (or
 * Previous and Next) with a sort, or by cursor as the older panel does. Rule: the key
 * `catalog.brand.read` and the admin population. One read-only unit.
 */
export class BrandList extends UseCase<BrandListInput, BrandListOutput, BrandListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-list',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_READ.key] },
  };

  readonly #logger = new Logger('BrandList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BrandListInput,
  ): Promise<Result<BrandListOutput, BrandListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.brand-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: BrandListInput,
  ): Promise<Result<BrandListOutput, BrandListFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input, [
      ...BRAND_FILTER_KEYS,
      'q',
      'search',
      'afterId',
      'limit',
      'sort',
      'direction',
      'page',
      'pageSize',
      'paging',
    ]);
    if (!body.ok) return body;
    const filtered = brandListFilterOf(body.value);
    if (!filtered.ok) return filtered;
    const read = readCatalogListInput(body.value, {
      sorts: BRAND_SORTS,
      defaultSort: 'name',
      defaultDirection: (sort) => (sort === 'name' ? 'asc' : 'desc'),
      pageDefault: BRAND_PAGE_DEFAULT,
      pageMax: BRAND_PAGE_MAX,
      maxPage: BRAND_MAX_PAGE,
      cursorIdOf: (value) => {
        const parsed = brandIdOf(value, 'afterId');
        return parsed.ok ? parsed.value : null;
      },
    });
    if (!read.ok) return read;
    const { market } = context;
    const filter = { ...filtered.value, search: read.value.q };
    const unit = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<BrandPageRead, never>> => {
        if (read.value.mode === 'cursor') {
          const found = await this.deps.brandReader.list(market, {
            ...filter,
            afterId: read.value.afterId as Id<'Brand'> | null,
            limit: read.value.limit,
          });
          return ok({
            rows: found.items,
            nextAfterId: found.nextAfterId,
            total: null as number | null,
            page: 1,
            pageSize: read.value.limit,
            paging: 'prev-next',
            hasNext: found.nextAfterId !== null,
          });
        }
        const paged = read.value.paged;
        const window = pageWindow(paged);
        const total =
          paged.paging === 'pages' ? await this.deps.brandReader.count(market, filter) : null;
        const rows =
          total !== null && window.offset >= total
            ? []
            : await this.deps.brandReader.page(market, {
                ...filter,
                sort: paged.sort,
                direction: paged.direction,
                offset: window.offset,
                limit: window.limit,
              });
        const shown = listPage(rows, paged, total);
        return ok({
          rows: shown.items,
          // The current panel pages by cursor: on its order (the default sort, ascending) the page
          // read names the cursor of the next page too.
          nextAfterId:
            shown.hasNext && paged.sort === 'name' && paged.direction === 'asc'
              ? (shown.items[shown.items.length - 1]?.id ?? null)
              : null,
          total: shown.total,
          page: shown.page,
          pageSize: shown.pageSize,
          paging: shown.paging,
          hasNext: shown.hasNext,
        });
      },
      { readOnly: true },
    );
    if (!unit.ok) return err({ code: 'access.unavailable' });
    const granted = await heldKeys(context, { [CATALOG_BRAND_EDIT.key]: this.deps.brandEditProbe });
    const { rows, ...rest } = unit.value;
    return ok({
      items: rows.map((state) => ({
        ...viewOf(state),
        actions: rowActions(state, BRAND_ACTION_RULES, granted),
      })),
      ...rest,
    });
  }
}
