import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_TOPIC_SUGGESTION_REVIEW } from '../../contracts/permissions';
import { suggestTopicSlug } from '../../domain/topic';
import { marketLocalesOf, type MarketLocales } from '../attributes/attribute-admin-views';
import { closedInput, invalid, type ValidationFailure } from '../topics/topic-views';
import type { TopicSuggestionStore } from '../ports/topic-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';

export const SUGGESTION_PAGE_DEFAULT = 50;
export const SUGGESTION_PAGE_MAX = 100;

export interface TopicSuggestionListInput {
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
}

export interface TopicSuggestionListOutput {
  readonly items: readonly SuggestionListItem[];
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
        const open = await this.deps.topicSuggestions.listOpen(market, limit);
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
