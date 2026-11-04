import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_VIEW } from '../../contracts/permissions';
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
} from '../attributes/attribute-admin-views';
import { closedInput, invalid, type ValidationFailure } from '../brands/brand-views';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface AttributeAdminListInput {
  readonly search?: unknown;
  readonly type?: unknown;
  readonly status?: unknown;
  readonly usedIn?: unknown;
  readonly missing?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

export interface AttributeListItem extends AttributeSummaryView {
  /** Products of the Market whose published revision carries a value for it. */
  readonly productCount: number;
  /** Feature sets whose published revision names it. */
  readonly featureSetCount: number;
}

export interface AttributeAdminListOutput {
  readonly items: readonly AttributeListItem[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
  /** The definitions that match the filters, across every page. */
  readonly total: number;
  /** Every definition of the Market, whatever the filters (the tab count). */
  readonly totalAll: number;
  /** The Market's locales: the default first, then every supported one. */
  readonly locales: MarketLocales;
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
    ]);
    if (!body.ok) return body;
    const { market } = context;
    const locales = marketLocalesOf(this.deps.policy.locales(market));
    const filter = listFilterOf(body.value, locales);
    if (!filter.ok) return filter;
    let afterId: string | null = null;
    const rawAfter = body.value['afterId'];
    if (rawAfter !== undefined && rawAfter !== null && rawAfter !== '') {
      afterId = attributeIdOf(rawAfter);
      if (afterId === null) return invalid('afterId', 'format');
    }
    let limit = ATTRIBUTE_PAGE_DEFAULT;
    const rawLimit = body.value['limit'];
    if (rawLimit !== undefined && rawLimit !== null) {
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
    const reader = this.deps.attributeAdminReader;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const definitions = await reader.definitions(market, ATTRIBUTE_LOAD_MAX + 1);
        const featureSets = await reader.featureSets(market, FEATURE_SET_LOAD_MAX);
        const loaded = definitions.slice(0, ATTRIBUTE_LOAD_MAX);
        const matching = loaded.filter((definition) =>
          matchesFilter(definition, filter.value, featureSets, locales),
        );
        const page = pageOf(matching, afterId, limit);
        const counts = await reader.productCounts(
          market,
          page.items.map((definition) => ({
            code: definition.code,
            isVariantOption: definition.revision.isVariantOption,
          })),
        );
        return ok({
          items: page.items.map((definition) => ({
            ...summaryOf(definition, locales),
            productCount: counts.get(definition.code) ?? 0,
            featureSetCount: new Set(
              usesOf(definition.code, featureSets).map((use) => use.featureSetId),
            ).size,
          })),
          nextAfterId: page.nextAfterId,
          total: matching.length,
          totalAll: loaded.length,
          locales,
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
