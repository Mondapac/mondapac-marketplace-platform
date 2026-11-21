import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  heldKeys,
  listPage,
  parseNamedInstantRange,
  pageWindow,
  rowActions,
  type ListPagingMode,
  type PermissionProbe,
  type RowActionRule,
} from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_BUSINESS_ACTIVITY_EDIT,
  CATALOG_BUSINESS_ACTIVITY_READ,
} from '../../contracts/permissions';
import type { BusinessActivityState } from '../../domain/business-activity';
import {
  ACTIVITY_PAGE_DEFAULT,
  ACTIVITY_PAGE_MAX,
  activityIdOf,
  adminAccountOf,
  closedInput,
  statusOf,
  viewOf,
  type BusinessActivityView,
  type ValidationFailure,
} from '../business-activities/business-activity-views';
import { readCatalogListInput } from '../lists/catalog-list-input';
import { ACTIVITY_SORTS, type BusinessActivityReader } from '../ports/business-activity.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

/** The highest page number: 100 pages of 100 stay within the paged rows cap. */
export const ACTIVITY_MAX_PAGE = 100;

/**
 * What each row action needs (the plan's table, row 9): `edit` and `deactivate` both go through
 * the edit route (`status` is part of the edit) with `catalog.business-activity.edit`; there is
 * nothing to deactivate on an inactive activity.
 */
export const ACTIVITY_ACTION_RULES: readonly RowActionRule<
  Pick<BusinessActivityState, 'status'>
>[] = [
  { id: 'edit', permission: CATALOG_BUSINESS_ACTIVITY_EDIT.key },
  {
    id: 'deactivate',
    permission: CATALOG_BUSINESS_ACTIVITY_EDIT.key,
    when: (row) => row.status === 'active',
  },
];

export interface BusinessActivityListInput {
  readonly status?: unknown;
  /** The search text; `search` is the older name of it. */
  readonly q?: unknown;
  readonly search?: unknown;
  /** Created at or after this ISO 8601 instant (inclusive). */
  readonly createdFrom?: unknown;
  /** Created before this ISO 8601 instant (exclusive). */
  readonly createdTo?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly paging?: unknown;
}

export interface BusinessActivityListItem extends BusinessActivityView {
  /** The row actions of the Actions menu the caller may run: edit, deactivate. */
  readonly actions: readonly string[];
}

export interface BusinessActivityListOutput {
  readonly items: readonly BusinessActivityListItem[];
  /** The `afterId` of the next page of the cursor read; null on the last page and on a page read. */
  readonly nextAfterId: string | null;
  /** Activities matching over all pages; null in `prev-next` mode and on a cursor read. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  /** The Market's locales: the language dropdown of the form offers the supported ones. */
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
}

export type BusinessActivityListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface BusinessActivityListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly activityReader: BusinessActivityReader;
  readonly policy: CatalogMarketPolicy;
  readonly activityEditProbe: PermissionProbe;
}

interface ActivityPageRead {
  readonly rows: readonly BusinessActivityState[];
  readonly nextAfterId: string | null;
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
}

/**
 * `business-activity.list` (catalog business-activity package, super list 9): the activities of
 * the Market for the admin panel and its searchable pickers; `status` filters and `q` (older name
 * `search`) matches a name in any locale or the code. Read by page number (or Previous and Next)
 * with a sort, or by cursor as the older panel does. Rule: the key
 * `catalog.business-activity.read` and the admin population. One read-only unit.
 */
export class BusinessActivityList extends UseCase<
  BusinessActivityListInput,
  BusinessActivityListOutput,
  BusinessActivityListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.business-activity-list',
    rule: { kind: 'permissions', allOf: [CATALOG_BUSINESS_ACTIVITY_READ.key] },
  };

  readonly #logger = new Logger('BusinessActivityList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BusinessActivityListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BusinessActivityListInput,
  ): Promise<Result<BusinessActivityListOutput, BusinessActivityListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.business-activity-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: BusinessActivityListInput,
  ): Promise<Result<BusinessActivityListOutput, BusinessActivityListFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, [
      'status',
      'createdFrom',
      'createdTo',
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
    let status = null;
    if (body.value['status'] !== undefined && body.value['status'] !== null) {
      const parsed = statusOf(body.value['status'], 'status');
      if (!parsed.ok) return parsed;
      status = parsed.value;
    }
    const created = parseNamedInstantRange(body.value, 'createdFrom', 'createdTo');
    if (!created.ok) return created;
    const read = readCatalogListInput(body.value, {
      sorts: ACTIVITY_SORTS,
      defaultSort: 'code',
      defaultDirection: (sort) => (sort === 'code' ? 'asc' : 'desc'),
      pageDefault: ACTIVITY_PAGE_DEFAULT,
      pageMax: ACTIVITY_PAGE_MAX,
      maxPage: ACTIVITY_MAX_PAGE,
      cursorIdOf: (value) => {
        const parsed = activityIdOf(value, 'afterId');
        return parsed.ok ? parsed.value : null;
      },
    });
    if (!read.ok) return read;
    const { market } = context;
    const filter = {
      status,
      search: read.value.q,
      createdFrom: created.value.from,
      createdTo: created.value.to,
    };
    const reader = this.deps.activityReader;
    const unit = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<ActivityPageRead, never>> => {
        if (read.value.mode === 'cursor') {
          const found = await reader.list(market, {
            ...filter,
            afterId: read.value.afterId as Id<'BusinessActivity'> | null,
            limit: read.value.limit,
          });
          return ok({
            rows: found.items,
            nextAfterId: found.nextAfterId,
            total: null,
            page: 1,
            pageSize: read.value.limit,
            paging: 'prev-next',
            hasNext: found.nextAfterId !== null,
          });
        }
        const paged = read.value.paged;
        const window = pageWindow(paged);
        const total = paged.paging === 'pages' ? await reader.count(market, filter) : null;
        const rows =
          total !== null && window.offset >= total
            ? []
            : await reader.page(market, {
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
            shown.hasNext && paged.sort === 'code' && paged.direction === 'asc'
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
    const granted = await heldKeys(context, {
      [CATALOG_BUSINESS_ACTIVITY_EDIT.key]: this.deps.activityEditProbe,
    });
    const locales = this.deps.policy.locales(market);
    const { rows, ...rest } = unit.value;
    return ok({
      items: rows.map((state) => ({
        ...viewOf(state),
        actions: rowActions(state, ACTIVITY_ACTION_RULES, granted),
      })),
      ...rest,
      locales: { default: locales.default, supported: [...locales.supported] },
    });
  }
}
