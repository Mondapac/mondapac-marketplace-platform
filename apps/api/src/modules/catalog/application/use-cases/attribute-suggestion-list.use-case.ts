import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  parseNamedInstantRange,
  listPage,
  pageWindow,
  parseListQuery,
  rowActions,
  type ListPagingMode,
  type RowActionRule,
} from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_SUGGESTION_DECIDE } from '../../contracts/permissions';
import { marketLocalesOf, type MarketLocales } from '../attributes/attribute-admin-views';
import { closedInput, invalid, type ValidationFailure } from '../attributes/attribute-editor';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeValueSuggestionStore } from '../ports/attribute-value-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';

export const SUGGESTION_PAGE_DEFAULT = 50;
export const SUGGESTION_PAGE_MAX = 100;

export const SUGGESTION_MAX_PAGE = 100;
/** One sort, by the time of the suggestion: `asc` (default) puts the one waiting longest first. */
export const SUGGESTION_SORTS = ['created'] as const;
const MAX_TEXT = 100;

export interface AttributeSuggestionListInput {
  readonly q?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly paging?: unknown;
  /** The older panel's page size; an alias of `pageSize` until the panel pages by number. */
  readonly limit?: unknown;
}

/**
 * What each row action needs (the plan's table, row 7): all three decide with the list's own key;
 * `map` needs a value to map to.
 */
export const SUGGESTION_ACTION_RULES: readonly RowActionRule<
  Pick<SuggestionListItem, 'attribute'>
>[] = [
  { id: 'approve', permission: null },
  { id: 'map', permission: null, when: (row) => row.attribute.options.length > 0 },
  { id: 'reject', permission: null },
];

export interface SuggestionListItem {
  readonly id: string;
  readonly version: number;
  /** The seller's own words, in the Market's default locale. */
  readonly label: string;
  readonly createdAt: string;
  readonly sellerId: string;
  readonly productId: string;
  readonly productCode: string | null;
  /** The row actions of the Actions menu: `approve`, `map`, `reject`. */
  readonly actions: readonly string[];
  readonly attribute: {
    readonly id: string;
    readonly code: string;
    readonly names: Readonly<Record<string, string>>;
    readonly multi: boolean;
    /** The values the admin may map to (active ones), in order. */
    readonly options: readonly {
      readonly code: string;
      readonly labels: Readonly<Record<string, string>>;
    }[];
  };
}

export interface AttributeSuggestionListOutput {
  readonly items: readonly SuggestionListItem[];
  /** Open suggestions matching the search over all pages; null in `prev-next` mode. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  /** The locales an approval must name the value in: the Market's default only, for now. */
  readonly requiredLocales: readonly string[];
  readonly locales: MarketLocales;
}

export type AttributeSuggestionListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface AttributeSuggestionListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly suggestions: AttributeValueSuggestionStore;
  readonly attributeStore: AttributeDefinitionStore;
  readonly products: ProductRepository;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `attribute-suggestion.list` (attributes plan, package A5): the open value suggestions of the
 * Market, oldest first, each with the attribute and the values it already has, for the "Waiting
 * for you" tab. Rule: the key `catalog.attribute-suggestion.decide` and the admin population.
 * One read-only unit. The seller's text is shown to the admin as plain text and nowhere else.
 */
export class AttributeSuggestionList extends UseCase<
  AttributeSuggestionListInput,
  AttributeSuggestionListOutput,
  AttributeSuggestionListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-suggestion-list',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_SUGGESTION_DECIDE.key] },
  };

  readonly #logger = new Logger('AttributeSuggestionList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeSuggestionListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeSuggestionListInput,
  ): Promise<Result<AttributeSuggestionListOutput, AttributeSuggestionListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-suggestion-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: AttributeSuggestionListInput,
  ): Promise<Result<AttributeSuggestionListOutput, AttributeSuggestionListFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input ?? {}, [
      'q',
      'createdFrom',
      'createdTo',
      'sort',
      'direction',
      'page',
      'pageSize',
      'paging',
      'limit',
    ]);
    if (!body.ok) return body;
    const created = parseNamedInstantRange(body.value, 'createdFrom', 'createdTo');
    if (!created.ok) return created;
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
      sorts: SUGGESTION_SORTS,
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
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const filter = { text, createdFrom: created.value.from, createdTo: created.value.to };
        const total =
          paged.value.paging === 'pages'
            ? await this.deps.suggestions.countOpen(market, filter)
            : null;
        const found =
          total !== null && window.offset >= total
            ? []
            : await this.deps.suggestions.pageOpen(market, {
                ...filter,
                direction: paged.value.direction,
                offset: window.offset,
                limit: window.limit,
              });
        // The extra row of the prev-next read only tells there is a next page; it is not shown.
        const open = found.slice(0, paged.value.pageSize);
        const definitions = new Map<string, SuggestionListItem['attribute'] | null>();
        const items: SuggestionListItem[] = [];
        for (const suggestion of open) {
          const state = suggestion.state;
          if (!definitions.has(state.definitionId)) {
            const definition = await this.deps.attributeStore.findById(market, state.definitionId);
            definitions.set(
              state.definitionId,
              definition === null
                ? null
                : {
                    id: definition.state.id,
                    code: definition.state.code,
                    names: definition.state.names,
                    multi: definition.state.dataType === 'multi-select',
                    options: definition.state.options
                      .filter((option) => option.active)
                      .map((option) => ({ code: option.code, labels: option.labels })),
                  },
            );
          }
          const attribute = definitions.get(state.definitionId);
          if (attribute === null || attribute === undefined) continue;
          const product = await this.deps.products.findById(market, state.productId);
          items.push({
            id: state.id,
            version: state.version,
            label: state.label,
            createdAt: state.createdAt.toString(),
            sellerId: state.sellerId,
            productId: state.productId,
            productCode: product === null ? null : product.state.productCode,
            actions: rowActions({ attribute }, SUGGESTION_ACTION_RULES, new Set()),
            attribute,
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
