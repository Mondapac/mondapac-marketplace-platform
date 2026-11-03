import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
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

export interface AttributeSuggestionListInput {
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
    const body = closedInput(input ?? {}, ['limit']);
    if (!body.ok) return body;
    let limit = SUGGESTION_PAGE_DEFAULT;
    const rawLimit = body.value['limit'];
    if (rawLimit !== undefined && rawLimit !== null) {
      if (
        typeof rawLimit !== 'number' ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > SUGGESTION_PAGE_MAX
      ) {
        return invalid('limit', 'range');
      }
      limit = rawLimit;
    }
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
        const open = await this.deps.suggestions.listOpen(market, limit);
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
            attribute,
          });
        }
        return ok({ items, requiredLocales: [locales.default], locales });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok(read.value);
  }
}
