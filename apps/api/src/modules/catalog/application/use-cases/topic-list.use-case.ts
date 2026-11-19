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
import { CATALOG_TOPIC_MANAGE, CATALOG_TOPIC_READ } from '../../contracts/permissions';
import { TOPIC_GROUPS, TOPIC_SYNONYMS_MAX, type TopicState } from '../../domain/topic';
import {
  TOPIC_PAGE_DEFAULT,
  TOPIC_PAGE_MAX,
  adminAccountOf,
  closedInput,
  topicGroupOf,
  topicIdOf,
  topicStatusOf,
  viewOf,
  type TopicView,
  type ValidationFailure,
} from '../topics/topic-views';
import { readCatalogListInput } from '../lists/catalog-list-input';
import { TOPIC_SORTS, type TopicReader } from '../ports/topic.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

/** The highest page number: 100 pages of 100 stay within the paged rows cap. */
export const TOPIC_MAX_PAGE = 100;

/**
 * What each row action needs (the plan's table, row 10): `edit` takes `catalog.topic.manage`. The
 * plan also names merge and delete; there is no merge or delete route for a tag, so neither is
 * offered (a design question, not an invented route).
 */
export const TOPIC_ACTION_RULES: readonly RowActionRule<Pick<TopicState, 'status'>>[] = [
  { id: 'edit', permission: CATALOG_TOPIC_MANAGE.key },
];

export interface TopicListInput {
  readonly status?: unknown;
  readonly group?: unknown;
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

export interface TopicListItem extends TopicView {
  /** The row actions of the Actions menu the caller may run: edit. */
  readonly actions: readonly string[];
}

export interface TopicListOutput {
  readonly items: readonly TopicListItem[];
  /** The `afterId` of the next page of the cursor read; null on the last page and on a page read. */
  readonly nextAfterId: string | null;
  /** Topics matching over all pages; null in `prev-next` mode and on a cursor read. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  /** The Market's locales: the language dropdown of the form offers the supported ones. */
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
  /** The groups a topic may sit in and the most synonyms per locale, for the form. */
  readonly groups: readonly string[];
  readonly maxSynonyms: number;
}

export type TopicListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface TopicListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly topicReader: TopicReader;
  readonly policy: CatalogMarketPolicy;
  readonly topicManageProbe: PermissionProbe;
}

interface TopicPageRead {
  readonly rows: readonly TopicState[];
  readonly nextAfterId: string | null;
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
}

/**
 * `topic.list` (product tags package T1, super list 10): the topics of the Market for the admin
 * panel and its searchable pickers; `status` and `group` filter and `q` (older name `search`)
 * matches a name or synonym in any locale or the slug. Read by page number (or Previous and Next)
 * with a sort, or by cursor as the older panel does. Rule: the key
 * `catalog.topic.read` and the admin population. One read-only unit.
 */
export class TopicList extends UseCase<TopicListInput, TopicListOutput, TopicListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-list',
    rule: { kind: 'permissions', allOf: [CATALOG_TOPIC_READ.key] },
  };

  readonly #logger = new Logger('TopicList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: TopicListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TopicListInput,
  ): Promise<Result<TopicListOutput, TopicListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.topic-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: TopicListInput,
  ): Promise<Result<TopicListOutput, TopicListFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, [
      'status',
      'group',
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
      const parsed = topicStatusOf(body.value['status'], 'status');
      if (!parsed.ok) return parsed;
      status = parsed.value;
    }
    let group = null;
    if (body.value['group'] !== undefined && body.value['group'] !== null) {
      const parsed = topicGroupOf(body.value['group'], 'group');
      if (!parsed.ok) return parsed;
      group = parsed.value;
    }
    const read = readCatalogListInput(body.value, {
      sorts: TOPIC_SORTS,
      defaultSort: 'slug',
      defaultDirection: (sort) => (sort === 'slug' ? 'asc' : 'desc'),
      pageDefault: TOPIC_PAGE_DEFAULT,
      pageMax: TOPIC_PAGE_MAX,
      maxPage: TOPIC_MAX_PAGE,
      cursorIdOf: (value) => {
        const parsed = topicIdOf(value, 'afterId');
        return parsed.ok ? parsed.value : null;
      },
    });
    if (!read.ok) return read;
    const { market } = context;
    const filter = { status, group, search: read.value.q };
    const reader = this.deps.topicReader;
    const unit = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<TopicPageRead, never>> => {
        if (read.value.mode === 'cursor') {
          const found = await reader.list(market, {
            ...filter,
            afterId: read.value.afterId as Id<'Topic'> | null,
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
            shown.hasNext && paged.sort === 'slug' && paged.direction === 'asc'
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
      [CATALOG_TOPIC_MANAGE.key]: this.deps.topicManageProbe,
    });
    const locales = this.deps.policy.locales(market);
    const { rows, ...rest } = unit.value;
    return ok({
      items: rows.map((state) => ({
        ...viewOf(state),
        actions: rowActions(state, TOPIC_ACTION_RULES, granted),
      })),
      ...rest,
      locales: { default: locales.default, supported: [...locales.supported] },
      groups: [...TOPIC_GROUPS],
      maxSynonyms: TOPIC_SYNONYMS_MAX,
    });
  }
}
