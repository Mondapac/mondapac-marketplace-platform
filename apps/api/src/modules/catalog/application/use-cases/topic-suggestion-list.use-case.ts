import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  listPage,
  pageWindow,
  parseListQuery,
  heldKeys,
  rowActions,
  type ListPagingMode,
  type PermissionProbe,
  type RowActionRule,
} from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_TOPIC_MANAGE, CATALOG_TOPIC_SUGGESTION_REVIEW } from '../../contracts/permissions';
import { suggestTopicSlug } from '../../domain/topic';
import { marketLocalesOf, type MarketLocales } from '../attributes/attribute-admin-views';
import { closedInput, invalid, type ValidationFailure } from '../topics/topic-views';
import type { TopicSuggestionStore } from '../ports/topic-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';

export const SUGGESTION_PAGE_DEFAULT = 50;
export const SUGGESTION_PAGE_MAX = 100;

/** One sort, by the time of the suggestion: `asc` (default) puts the one waiting longest first. */
export const TOPIC_SUGGESTION_SORTS = ['created'] as const;
export const SUGGESTION_MAX_PAGE = 100;
const MAX_TEXT = 100;

/**
 * What each row action needs (the plan's table, row 11): `map` and `reject` decide with the list's own
 * key; `approve` also creates a tag, so it needs `catalog.topic.manage` as its use case does.
 */
export const TOPIC_SUGGESTION_ACTION_RULES: readonly RowActionRule<Record<string, never>>[] = [
  { id: 'approve', permission: CATALOG_TOPIC_MANAGE.key },
  { id: 'map', permission: null },
  { id: 'reject', permission: null },
];

export interface TopicSuggestionListInput {
  readonly q?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly paging?: unknown;
  /** The older panel's page size; an alias of `pageSize` until the panel pages by number. */
  readonly limit?: unknown;
}

export interface SuggestionListItem {
  readonly id: string;
  readonly version: number;
  /** The seller's own words, in the Market's default locale. */
  readonly label: string;
  readonly createdAt: string;
  readonly sellerId: string;
  readonly productId: string;
  readonly productCode: string | null;
  /** The slug the free form of the label suggests, for the approve form. */
  readonly suggestedSlug: string;
  /** The row actions of the Actions menu: `approve`, `map`, `reject`. */
  readonly actions: readonly string[];
}

export interface TopicSuggestionListOutput {
  readonly items: readonly SuggestionListItem[];
  /** Open suggestions matching the search over all pages; null in `prev-next` mode. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  /** The locales an approval must name the tag in: the Market's default only, for now. */
  readonly requiredLocales: readonly string[];
  readonly locales: MarketLocales;
}

export type TopicSuggestionListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface TopicSuggestionListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly topicSuggestions: TopicSuggestionStore;
  readonly products: ProductRepository;
  readonly policy: CatalogMarketPolicy;
  readonly topicManageProbe: PermissionProbe;
}

/**
 * `topic-suggestion.list` (product tags package T5): the open tag suggestions of the
 * Market, oldest first, for the "Tag suggestions" queue. Rule: the key `catalog.topic-suggestion.review` and the admin population.
 * One read-only unit. The seller's text is shown to the admin as plain text and nowhere else.
 */
export class TopicSuggestionList extends UseCase<
  TopicSuggestionListInput,
  TopicSuggestionListOutput,
  TopicSuggestionListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-suggestion-list',
    rule: { kind: 'permissions', allOf: [CATALOG_TOPIC_SUGGESTION_REVIEW.key] },
  };

  readonly #logger = new Logger('TopicSuggestionList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: TopicSuggestionListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TopicSuggestionListInput,
  ): Promise<Result<TopicSuggestionListOutput, TopicSuggestionListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.topic-suggestion-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: TopicSuggestionListInput,
  ): Promise<Result<TopicSuggestionListOutput, TopicSuggestionListFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input ?? {}, [
      'q',
      'sort',
      'direction',
      'page',
      'pageSize',
      'paging',
      'limit',
    ]);
    if (!body.ok) return body;
    const absent = (value: unknown) => value === undefined || value === null || value === '';
    let text: string | null = null;
    const rawText = body.value['q'];
    if (!absent(rawText)) {
      if (typeof rawText !== 'string') return invalid('q', 'type');
      const trimmed = rawText.trim();
      if ([...trimmed].length > MAX_TEXT) return invalid('q', 'length');
      if (/\p{Cc}/u.test(trimmed)) return invalid('q', 'format');
      text = trimmed === '' ? null : trimmed;
    }
    const { limit: legacyLimit, ...rest } = body.value;
    if (!absent(legacyLimit)) {
      if (!absent(rest['pageSize'])) return invalid('limit', 'conflict');
      if (
        typeof legacyLimit !== 'number' ||
        !Number.isInteger(legacyLimit) ||
        legacyLimit < 1 ||
        legacyLimit > SUGGESTION_PAGE_MAX
      ) {
        return invalid('limit', 'range');
      }
    }
    const paged = parseListQuery(absent(legacyLimit) ? rest : { ...rest, pageSize: legacyLimit }, {
      sorts: TOPIC_SUGGESTION_SORTS,
      defaultSort: 'created',
      defaultDirection: () => 'asc',
      defaultPageSize: SUGGESTION_PAGE_DEFAULT,
      maxPageSize: SUGGESTION_PAGE_MAX,
      maxPage: SUGGESTION_MAX_PAGE,
    });
    if (!paged.ok) return paged;
    const window = pageWindow(paged.value);
    const { market } = context;
    let locales: MarketLocales;
    try {
      locales = marketLocalesOf(this.deps.policy.locales(market));
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const granted = await heldKeys(context, {
      [CATALOG_TOPIC_MANAGE.key]: this.deps.topicManageProbe,
    });
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const filter = { text };
        const total =
          paged.value.paging === 'pages'
            ? await this.deps.topicSuggestions.countOpen(market, filter)
            : null;
        const found =
          total !== null && window.offset >= total
            ? []
            : await this.deps.topicSuggestions.pageOpen(market, {
                ...filter,
                direction: paged.value.direction,
                offset: window.offset,
                limit: window.limit,
              });
        // The extra row of the prev-next read only tells there is a next page; it is not shown.
        const open = found.slice(0, paged.value.pageSize);
        const items: SuggestionListItem[] = [];
        for (const suggestion of open) {
          const state = suggestion.state;
          const product = await this.deps.products.findById(market, state.productId);
          items.push({
            id: state.id,
            version: state.version,
            label: state.label,
            createdAt: state.createdAt.toString(),
            sellerId: state.sellerId,
            productId: state.productId,
            productCode: product === null ? null : product.state.productCode,
            suggestedSlug: suggestTopicSlug(state.label),
            actions: rowActions({}, TOPIC_SUGGESTION_ACTION_RULES, granted),
          });
        }
        return ok({
          items,
          total,
          hasNextRow: found.length > paged.value.pageSize,
          requiredLocales: [locales.default],
          locales,
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { items, total, hasNextRow } = read.value;
    const page = listPage(items, paged.value, total);
    return ok({
      items: page.items,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      paging: page.paging,
      hasNext: paged.value.paging === 'pages' ? page.hasNext : hasNextRow,
      requiredLocales: read.value.requiredLocales,
      locales: read.value.locales,
    });
  }
}
