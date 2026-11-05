import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import {
  MAX_OPEN_SUGGESTIONS_PER_SELLER,
  type SuggestionStatus,
} from '../../domain/attribute-value-suggestion';
import {
  DEFAULT_PAGE_SIZE,
  invalid,
  isoOf,
  MAX_PAGE_SIZE,
  sellerOf,
  type ValidationFailure,
} from '../own-reads/own-reads.shared';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeValueSuggestionStore } from '../ports/attribute-value-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import type { ProductRepository } from '../ports/product.repository';
import { draftNameOf } from './own-products-list.use-case';

const STATUSES: readonly SuggestionStatus[] = ['open', 'approved', 'mapped', 'rejected'];

export interface OwnAttributeSuggestionsListInput {
  readonly status?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

export interface OwnSuggestionItem {
  readonly id: string;
  readonly status: SuggestionStatus;
  /** The seller's own words, as stored. */
  readonly label: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  /** The reviewer's words to the seller, for a rejected suggestion; else null. */
  readonly rejectReason: string | null;
  readonly attribute: {
    readonly code: string;
    readonly names: Readonly<Record<string, string>>;
  } | null;
  /** The value added (approved) or chosen (mapped); else null. */
  readonly value: {
    readonly code: string;
    readonly labels: Readonly<Record<string, string>>;
  } | null;
  readonly product: {
    readonly id: string;
    /** Null when the product is no longer readable (never another seller's). */
    readonly productCode: string | null;
    /** The draft name in the Market's default locale, else null. */
    readonly name: string | null;
  };
}

export interface OwnAttributeSuggestionsListOutput {
  readonly items: readonly OwnSuggestionItem[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
  /** How many of the seller's suggestions wait for a decision, whatever the filter. */
  readonly openCount: number;
  readonly maxOpen: number;
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
}

export type OwnAttributeSuggestionsListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface OwnAttributeSuggestionsListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly suggestions: AttributeValueSuggestionStore;
  readonly attributeStore: AttributeDefinitionStore;
  readonly products: ProductRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
}

interface Page {
  readonly status: SuggestionStatus | null;
  readonly afterId: Id<'AttributeValueSuggestion'> | null;
  readonly limit: number;
}

/** A closed query: an optional status, previous-page id and size in 1 to 50. */
function parseQuery(input: unknown): Result<Page, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('query', 'type');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'status' && key !== 'afterId' && key !== 'limit') return invalid(key, 'unknown');
  }
  let status: SuggestionStatus | null = null;
  const rawStatus = record['status'];
  if (rawStatus !== undefined && rawStatus !== null) {
    if (typeof rawStatus !== 'string' || !STATUSES.includes(rawStatus as SuggestionStatus)) {
      return invalid('status', 'enum');
    }
    status = rawStatus as SuggestionStatus;
  }
  let afterId: Id<'AttributeValueSuggestion'> | null = null;
  const rawAfter = record['afterId'];
  if (rawAfter !== undefined && rawAfter !== null) {
    const parsed =
      typeof rawAfter === 'string' ? parseId<'AttributeValueSuggestion'>(rawAfter) : null;
    if (parsed === null || !parsed.ok) return invalid('afterId', 'format');
    afterId = parsed.value;
  }
  let limit = DEFAULT_PAGE_SIZE;
  const rawLimit = record['limit'];
  if (rawLimit !== undefined && rawLimit !== null) {
    if (
      typeof rawLimit !== 'number' ||
      !Number.isInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > MAX_PAGE_SIZE
    ) {
      return invalid('limit', 'range');
    }
    limit = rawLimit;
  }
  return ok({ status, afterId, limit });
}

/**
 * `own-attribute-suggestions.list` (attributes plan, package A5 follow-up; the seller's "Value
 * suggestions" page): the seller's own value suggestions in every status, newest first,
 * keyset-paged, each with its field, its product and its outcome (the value added or matched, or
 * the reviewer's reason). Rule: the key `catalog.own-product.view` and the seller population; the
 * seller comes from the actor and the store filters by it, so another seller's suggestion is never
 * read. One read-only unit (ADR-0025). The admin's identity is never shown.
 */
export class OwnAttributeSuggestionsList extends UseCase<
  OwnAttributeSuggestionsListInput,
  OwnAttributeSuggestionsListOutput,
  OwnAttributeSuggestionsListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-attribute-suggestions-list',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('OwnAttributeSuggestionsList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnAttributeSuggestionsListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnAttributeSuggestionsListInput,
  ): Promise<Result<OwnAttributeSuggestionsListOutput, OwnAttributeSuggestionsListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.own-attribute-suggestions-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: OwnAttributeSuggestionsListInput,
  ): Promise<Result<OwnAttributeSuggestionsListOutput, OwnAttributeSuggestionsListFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    const page = parseQuery(input ?? {});
    if (!page.ok) return page;
    const { market } = context;
    let locales: { default: string; supported: readonly string[] };
    try {
      const policyLocales = this.deps.policy.locales(market);
      locales = { default: policyLocales.default, supported: [...policyLocales.supported] };
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const { suggestions, attributeStore, products, ownReader } = this.deps;
        // One extra row tells whether another page follows.
        const rows = await suggestions.listOfSeller(market, sellerId, {
          ...page.value,
          limit: page.value.limit + 1,
        });
        const shown = rows.slice(0, page.value.limit);
        const openCount = await suggestions.openCountOfSeller(market, sellerId);

        const definitions = new Map<
          string,
          Awaited<ReturnType<AttributeDefinitionStore['findById']>>
        >();
        for (const { state } of shown) {
          if (!definitions.has(state.definitionId)) {
            definitions.set(
              state.definitionId,
              await attributeStore.findById(market, state.definitionId),
            );
          }
        }
        const productIds = [...new Set(shown.map(({ state }) => state.productId))];
        const codes = new Map<string, string | null>();
        for (const productId of productIds) {
          const product = await products.findById(market, productId);
          // Only the seller's own product is named; anything else reads as gone.
          codes.set(
            productId,
            product !== null &&
              product.state.scope === 'SELLER' &&
              product.state.ownerSellerId === sellerId
              ? product.state.productCode
              : null,
          );
        }
        const ownIds = productIds.filter((id) => codes.get(id) !== null);
        const copies = ownIds.length === 0 ? [] : await ownReader.findWorkingCopies(market, ownIds);
        const names = new Map(
          copies.map((copy) => [
            copy.productId as string,
            draftNameOf(copy.content, locales.default),
          ]),
        );

        const items = shown.map(({ state }): OwnSuggestionItem => {
          const definition = definitions.get(state.definitionId) ?? null;
          const option =
            definition === null || state.optionCode === null
              ? undefined
              : definition.state.options.find((candidate) => candidate.code === state.optionCode);
          const productCode = codes.get(state.productId) ?? null;
          return {
            id: state.id,
            status: state.status,
            label: state.label,
            createdAt: state.createdAt.toString(),
            decidedAt: isoOf(state.decidedAt),
            rejectReason: state.status === 'rejected' ? state.rejectReason : null,
            attribute:
              definition === null
                ? null
                : { code: definition.state.code, names: definition.state.names },
            value:
              state.optionCode === null
                ? null
                : { code: state.optionCode, labels: option?.labels ?? {} },
            product: {
              id: state.productId,
              productCode,
              name: productCode === null ? null : (names.get(state.productId) ?? null),
            },
          };
        });
        return ok({
          items,
          nextAfterId:
            rows.length > shown.length ? (shown[shown.length - 1]?.state.id ?? null) : null,
          openCount,
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({ ...read.value, maxOpen: MAX_OPEN_SUGGESTIONS_PER_SELLER, locales });
  }
}
