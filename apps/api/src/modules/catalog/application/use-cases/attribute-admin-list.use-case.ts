import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  heldKeys,
  listPage,
  pageWindow,
  parseListQuery,
  rowActions,
  type ListPagingMode,
  type PermissionProbe,
  type RowActionRule,
} from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_ATTRIBUTE_EDIT,
  CATALOG_ATTRIBUTE_RESTRUCTURE,
  CATALOG_ATTRIBUTE_VIEW,
} from '../../contracts/permissions';
import {
  ATTRIBUTE_LOAD_MAX,
  ATTRIBUTE_PAGE_DEFAULT,
  ATTRIBUTE_PAGE_MAX,
  FEATURE_SET_LOAD_MAX,
  attributeIdOf,
  listFilterOf,
  marketLocalesOf,
  matchesFilter,
  pageOf,
  summaryOf,
  usesOf,
  type AttributeSummaryView,
  type MarketLocales,
  type MarketUnit,
} from '../attributes/attribute-admin-views';
import { closedInput, invalid, type ValidationFailure } from '../brands/brand-views';
import type {
  AttributeAdminReader,
  AttributeDefinitionRecord,
} from '../ports/attribute-admin.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface AttributeAdminListInput {
  readonly search?: unknown;
  readonly type?: unknown;
  readonly status?: unknown;
  readonly usedIn?: unknown;
  readonly missing?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly paging?: unknown;
}

/** The sorts of the attribute list: by code (default), by name in the default locale, type, status. */
export const ATTRIBUTE_SORTS = ['code', 'name', 'type', 'status'] as const;
export const ATTRIBUTE_MAX_PAGE = 100;
const COLLATOR = new Intl.Collator('en');

/** What each row action needs (the plan's table, row 5): the key its use case checks and the state. */
export const ATTRIBUTE_ACTION_RULES: readonly RowActionRule<{ readonly status: string }>[] = [
  { id: 'edit', permission: CATALOG_ATTRIBUTE_EDIT.key, when: (row) => row.status !== 'archived' },
  { id: 'view-links', permission: null },
  {
    id: 'deactivate',
    permission: CATALOG_ATTRIBUTE_RESTRUCTURE.key,
    when: (row) => row.status === 'active',
  },
];

export interface AttributeListItem extends AttributeSummaryView {
  /** The row actions of the Actions menu the caller may run: edit, view-links, deactivate. */
  readonly actions: readonly string[];
  /** Products of the Market whose published revision carries a value for it. */
  readonly productCount: number;
  /** Feature sets whose published revision names it. */
  readonly featureSetCount: number;
}

export interface AttributeAdminListOutput {
  readonly items: readonly AttributeListItem[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
  /** The definitions that match the filters, across every page (always known: read in memory). */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  /** Whether a page after this one exists. */
  readonly hasNext: boolean;
  /** Every definition of the Market, whatever the filters (the tab count). */
  readonly totalAll: number;
  /** The Market's locales: the default first, then every supported one. */
  readonly locales: MarketLocales;
  /** The units the Market offers for a number-with-unit attribute (attributes A3). */
  readonly units: readonly MarketUnit[];
  /** The families the "Used in" filter offers, by code. */
  readonly featureSets: readonly { readonly id: string; readonly code: string }[];
  /** True when the Market holds more definitions than one read loads (never silently partial). */
  readonly truncated: boolean;
}

export type AttributeAdminListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface AttributeAdminListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly policy: CatalogMarketPolicy;
  /** The gate's answers to "does the caller hold this key", for the row actions. */
  readonly attributeEditProbe: PermissionProbe;
  readonly attributeRestructureProbe: PermissionProbe;
}

/**
 * `attribute.admin-list` (attributes plan, package A1): the attributes of the request's Market for
 * the admin panel, by code, filtered by a search over the code and every locale's name, the data
 * type, the status, a feature set that uses it and a locale it is missing in; keyset-paged by id.
 * Each row has its product and feature-set counts and the locales it misses. Rule: the key
 * `catalog.attribute.view` and the admin population. One read-only unit.
 */
export class AttributeAdminList extends UseCase<
  AttributeAdminListInput,
  AttributeAdminListOutput,
  AttributeAdminListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-admin-list',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_VIEW.key] },
  };

  readonly #logger = new Logger('AttributeAdminList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeAdminListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeAdminListInput,
  ): Promise<Result<AttributeAdminListOutput, AttributeAdminListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-admin-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: AttributeAdminListInput,
  ): Promise<Result<AttributeAdminListOutput, AttributeAdminListFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input, [
      'search',
      'type',
      'status',
      'usedIn',
      'missing',
      'afterId',
      'limit',
      'sort',
      'direction',
      'page',
      'pageSize',
      'paging',
    ]);
    if (!body.ok) return body;
    const { market } = context;
    const locales = marketLocalesOf(this.deps.policy.locales(market));
    const filter = listFilterOf(body.value, locales);
    if (!filter.ok) return filter;
    const present = (key: string): boolean =>
      body.value[key] !== undefined && body.value[key] !== null && body.value[key] !== '';
    // The older cursor read (`afterId`, `limit`) and the page read do not mix.
    const legacy = ['afterId', 'limit'].some(present);
    if (legacy) {
      const mixed = ['sort', 'direction', 'page', 'pageSize', 'paging'].find(present);
      if (mixed !== undefined) return invalid(mixed, 'conflict');
    }
    let afterId: string | null = null;
    const rawAfter = body.value['afterId'];
    if (present('afterId')) {
      afterId = attributeIdOf(rawAfter);
      if (afterId === null) return invalid('afterId', 'format');
    }
    let limit = ATTRIBUTE_PAGE_DEFAULT;
    const rawLimit = body.value['limit'];
    if (present('limit')) {
      if (
        typeof rawLimit !== 'number' ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > ATTRIBUTE_PAGE_MAX
      ) {
        return invalid('limit', 'range');
      }
      limit = rawLimit;
    }
    const paged = parseListQuery(body.value, {
      sorts: ATTRIBUTE_SORTS,
      defaultSort: 'code',
      defaultDirection: () => 'asc',
      defaultPageSize: ATTRIBUTE_PAGE_DEFAULT,
      maxPageSize: 100,
      maxPage: ATTRIBUTE_MAX_PAGE,
    });
    if (!paged.ok) return paged;
    const { sort, direction } = paged.value;
    const sign = direction === 'asc' ? 1 : -1;
    const defaultLocale = locales.default;
    const keyOf = (definition: AttributeDefinitionRecord): string =>
      sort === 'name'
        ? (definition.revision.names[defaultLocale] ?? '')
        : sort === 'type'
          ? definition.dataType
          : sort === 'status'
            ? definition.status
            : definition.code;
    const reader = this.deps.attributeAdminReader;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const definitions = await reader.definitions(market, ATTRIBUTE_LOAD_MAX + 1);
        const featureSets = await reader.featureSets(market, FEATURE_SET_LOAD_MAX);
        const loaded = definitions.slice(0, ATTRIBUTE_LOAD_MAX);
        const matching = loaded
          .filter((definition) => matchesFilter(definition, filter.value, featureSets, locales))
          // The order is the sort, then the code, so a page never repeats or skips a row.
          .sort(
            (a, b) =>
              sign * COLLATOR.compare(keyOf(a), keyOf(b)) ||
              (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
          );
        const window = pageWindow(paged.value);
        const page = legacy
          ? pageOf(matching, afterId, limit)
          : {
              items: matching.slice(window.offset, window.offset + window.limit),
              nextAfterId: null,
            };
        // The page read may hold one row more (prev-next); `listPage` drops it and tells `hasNext`.
        const result = legacy ? null : listPage(page.items, paged.value, matching.length);
        const shown = result?.items ?? page.items;
        const counts = await reader.productCounts(
          market,
          shown.map((definition) => ({
            code: definition.code,
            isVariantOption: definition.revision.isVariantOption,
          })),
        );
        const granted = await heldKeys(context, {
          [CATALOG_ATTRIBUTE_EDIT.key]: this.deps.attributeEditProbe,
          [CATALOG_ATTRIBUTE_RESTRUCTURE.key]: this.deps.attributeRestructureProbe,
        });
        return ok({
          items: shown.map((definition) => ({
            ...summaryOf(definition, locales),
            actions: rowActions(definition, ATTRIBUTE_ACTION_RULES, granted),
            productCount: counts.get(definition.code) ?? 0,
            featureSetCount: new Set(
              usesOf(definition.code, featureSets).map((use) => use.featureSetId),
            ).size,
          })),
          nextAfterId: page.nextAfterId,
          total: result === null ? matching.length : result.total,
          page: legacy ? 1 : paged.value.page,
          pageSize: legacy ? limit : paged.value.pageSize,
          paging: paged.value.paging,
          hasNext: result === null ? page.nextAfterId !== null : result.hasNext,
          totalAll: loaded.length,
          locales,
          units: this.deps.policy.units(market).map((unit) => ({ ...unit })),
          featureSets: featureSets.map((set) => ({ id: set.id, code: set.code })),
          truncated: definitions.length > ATTRIBUTE_LOAD_MAX,
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok(read.value);
  }
}
