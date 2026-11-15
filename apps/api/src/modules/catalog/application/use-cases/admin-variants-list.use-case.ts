import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  listPage,
  pageWindow,
  parseListQuery,
  type ListPagingMode,
} from '../../../../platform/list-query';
import { CATALOG_VARIANT_VIEW } from '../../contracts/permissions';
import { VARIANT_ISSUES, VARIANT_SORTS } from '../ports/variant-admin.reader';
import {
  closedQuery,
  FILTER_KEYS,
  isAdmin,
  localesOf,
  PAGE_KEYS,
  parseAfter,
  parseFilter,
  parseLimit,
  queryOf,
  VARIANTS_MAX_PAGE,
  VARIANTS_PAGE_SIZE,
  type AdminReadFailure,
  type VariantsFilter,
} from '../variants/variant-admin.shared';
import {
  viewOf,
  type AdminVariantsDependencies,
  type AdminVariantView,
} from '../variants/variant-views';

/** The issue filters the list takes (`issue`), for the route's documentation. */
export { VARIANT_ISSUES, VARIANT_SORTS };
export type { AdminVariantsDependencies, AdminVariantView };

export interface AdminVariantsListOutput {
  readonly items: readonly AdminVariantView[];
  /** Variants matching the filter over all pages; null in `prev-next` mode. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  /** Whether a page after this one exists. */
  readonly hasNext: boolean;
  /**
   * The cursor of the older panel (`after`, `limit`): the id to pass as `after` for the next page,
   * or null. Kept until the panel reads pages; a page read gives it too, for the same rows.
   */
  readonly nextAfter: string | null;
}

/**
 * `admin-variants.list` (variants V6, the Variants tab; super list phase 2, list 3): the variants
 * of every live product of the Market (published, paused included) with their issues and row
 * actions. `q` searches the product name (default locale), the product or variant code, the GTIN
 * digits and the sellers' SKUs; `typeCode` keeps the variants of one variant type; `issue` is one
 * of the ready-made filters. `sort` is `newest` (default, newest first), `code` or `gtin`, with
 * `direction`; paged by `page` and `pageSize` (1 to 100, default 25) in the mode `paging` names
 * (`pages` with a total, `prev-next` without). Rule: the key `catalog.variant.view` and the admin
 * population. One read-only unit.
 */
export class AdminVariantsList extends UseCase<
  Record<string, unknown>,
  AdminVariantsListOutput,
  AdminReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-variants-list',
    rule: { kind: 'permissions', allOf: [CATALOG_VARIANT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminVariantsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<Result<AdminVariantsListOutput, AdminReadFailure>> {
    if (!isAdmin(context)) return err({ code: 'access.denied' });
    const query = closedQuery(input, [...FILTER_KEYS, ...PAGE_KEYS, 'after', 'limit']);
    if (!query.ok) return query;
    const filter = parseFilter(query.value);
    if (!filter.ok) return filter;
    if (query.value['after'] !== undefined || query.value['limit'] !== undefined) {
      return this.#cursorRead(context, query.value, filter.value);
    }
    const paged = parseListQuery(query.value, {
      sorts: VARIANT_SORTS,
      defaultSort: 'newest',
      defaultDirection: (sort) => (sort === 'newest' ? 'desc' : 'asc'),
      defaultPageSize: VARIANTS_PAGE_SIZE.default,
      maxPageSize: VARIANTS_PAGE_SIZE.max,
      maxPage: VARIANTS_MAX_PAGE,
    });
    if (!paged.ok) return paged;
    const locales = localesOf(this.deps.policy, context);
    if (!locales.ok) return locales;
    const { market } = context;
    const window = pageWindow(paged.value);
    const base = queryOf(filter.value, { after: null, limit: window.limit }, locales.value);
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const { variantAdminReader: reader } = this.deps;
        // Previous and Next never counts (a count over a large list is what that mode avoids).
        const total =
          paged.value.paging === 'pages' ? await reader.variantsCount(market, base) : null;
        const page =
          total !== null && window.offset >= total
            ? { rows: [], nextAfter: null }
            : await reader.variantsPage(market, {
                ...base,
                window: {
                  offset: window.offset,
                  sort: paged.value.sort,
                  direction: paged.value.direction,
                },
              });
        return ok({ total, rows: page.rows });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const result = listPage(read.value.rows, paged.value, read.value.total);
    return ok({
      items: result.items.map((row) => viewOf(row, locales.value.default)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      paging: result.paging,
      hasNext: result.hasNext,
      nextAfter: result.hasNext ? (result.items.at(-1)?.variantId ?? null) : null,
    });
  }

  /** The older cursor read (`after`, `limit`, newest first), until the panel pages by number. */
  async #cursorRead(
    context: CallContext,
    input: Record<string, unknown>,
    filter: VariantsFilter,
  ): Promise<Result<AdminVariantsListOutput, AdminReadFailure>> {
    const after = parseAfter(input['after']);
    if (!after.ok) return after;
    const limit = parseLimit(input['limit']);
    if (!limit.ok) return limit;
    const locales = localesOf(this.deps.policy, context);
    if (!locales.ok) return locales;
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.deps.variantAdminReader.variantsPage(
            market,
            queryOf(filter, { after: after.value, limit: limit.value }, locales.value),
          ),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({
      items: read.value.rows.map((row) => viewOf(row, locales.value.default)),
      total: null,
      page: 1,
      pageSize: limit.value,
      paging: 'prev-next',
      hasNext: read.value.nextAfter !== null,
      nextAfter: read.value.nextAfter,
    });
  }
}
