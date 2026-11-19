import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { TopicSuggestedAudit } from '../../domain/audit';
import {
  MAX_OPEN_SUGGESTIONS_PER_SELLER,
  TopicSuggestion,
  tidySuggestionText,
  type SuggestionRefusal,
} from '../../domain/topic-suggestion';
import { sellerOf } from '../own-reads/own-reads.shared';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { TopicRepository } from '../ports/topic.repository';
import type { TopicSuggestionStore } from '../ports/topic-suggestion.store';
import { refuseTopicClaimWords, type TopicClaimWordFailure } from '../topics/topic-views';

export interface OwnTopicSuggestInput {
  readonly productId: unknown;
  readonly label: unknown;
}

export interface OwnTopicSuggestOutput {
  readonly id: string;
  readonly status: 'open';
  readonly version: number;
}

export type OwnTopicSuggestFailure =
  | SuggestionRefusal
  | TopicClaimWordFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'product.not-editable' }
  /** A tag with this name or synonym is on the list already: the seller should pick it. */
  | { readonly code: 'suggestion.topic-exists' }
  | { readonly code: 'suggestion.already-open' }
  | { readonly code: 'suggestion.limit-reached'; readonly max: number }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnTopicSuggestDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly topics: TopicRepository;
  readonly topicSuggestions: TopicSuggestionStore;
  readonly eligibility: SellerEligibilityReader;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A seller may suggest on a product that is still theirs to work on. */
const SUGGESTING_STATUSES: ReadonlySet<string> = new Set(['draft', 'unpublished', 'published']);

/**
 * `own-topic.suggest` (product tags package T5; john's decision 1): a seller asks for a tag the
 * list does not have. Rule: the key `catalog.own-product.edit`, the seller population and a seller
 * who may sell. The request names the product and the text; the seller, Market and status come from
 * stored state. A product of another seller, a PLATFORM product and an unknown id answer a
 * byte-identical `product.not-found`. The text is the seller's own in the Market's default locale
 * (2 to 40 characters); one that asserts a certification (halal, organic and the like) is refused
 * by the same claim-word check as a topic name, fail closed; one the list already has as a name or
 * synonym is `suggestion.topic-exists`. One open suggestion per seller and text, at most
 * {@link MAX_OPEN_SUGGESTIONS_PER_SELLER} open per seller. An admin decides it. Nothing is written
 * to the product. One audit row, with ids only.
 */
export class OwnTopicSuggest extends UseCase<
  OwnTopicSuggestInput,
  OwnTopicSuggestOutput,
  OwnTopicSuggestFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-topic-suggest',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnTopicSuggest');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnTopicSuggestDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnTopicSuggestInput,
  ): Promise<Result<OwnTopicSuggestOutput, OwnTopicSuggestFailure>> {
    const result = await this.#suggest(context, input);
    this.#logger.log({
      msg: 'catalog.own-topic-suggest',
      code: result.ok ? 'opened' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #suggest(
    context: CallContext,
    input: OwnTopicSuggestInput,
  ): Promise<Result<OwnTopicSuggestOutput, OwnTopicSuggestFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (!(await this.deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const fail = (path: string, code: string): Result<never, OwnTopicSuggestFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const productId =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (productId === null || !productId.ok) return fail('productId', 'format');
    if (typeof input.label !== 'string' || [...input.label].length > 200) {
      return fail('label', 'type');
    }
    const { market } = context;
    let defaultLocale: string;
    try {
      defaultLocale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const opened = TopicSuggestion.open({
      id: this.deps.ids.next<'TopicSuggestion'>(),
      marketId: market.marketId,
      sellerId,
      productId: productId.value,
      label: tidySuggestionText(input.label),
      now: this.deps.clock.now(),
    });
    if (!opened.ok) return err(opened.error);
    const { label, labelKey } = opened.value.state;

    // The claim check runs before the unit opens: the certification facade opens its own.
    const claim = await refuseTopicClaimWords(
      this.deps,
      context,
      { terms: [{ locale: defaultLocale, kind: 'name', text: label, key: labelKey }], intro: null },
      defaultLocale,
    );
    if (claim !== null) return err(claim);

    return this.deps.unitOfWork.run<OwnTopicSuggestOutput, OwnTopicSuggestFailure>(
      market,
      async () => {
        const { products, topics, topicSuggestions: suggestions } = this.deps;
        const product = await products.findById(market, productId.value);
        if (
          product === null ||
          product.state.scope !== 'SELLER' ||
          product.state.ownerSellerId !== sellerId
        ) {
          return err({ code: 'product.not-found' } as const);
        }
        if (!SUGGESTING_STATUSES.has(product.state.status)) {
          return err({ code: 'product.not-editable' } as const);
        }
        const taken = await topics.takenTermKeys(
          market,
          [{ locale: defaultLocale, key: labelKey }],
          null,
        );
        if (taken.length > 0) return err({ code: 'suggestion.topic-exists' } as const);
        if (
          (await suggestions.openCountOfSeller(market, sellerId)) >= MAX_OPEN_SUGGESTIONS_PER_SELLER
        ) {
          return err({
            code: 'suggestion.limit-reached',
            max: MAX_OPEN_SUGGESTIONS_PER_SELLER,
          } as const);
        }
        const refused = await suggestions.add(market, opened.value);
        if (refused !== null) return err({ code: refused } as const);
        await this.deps.audit.record(
          context,
          TopicSuggestedAudit.entry(opened.value.state.id, {
            after: { productId: product.state.id },
          }),
        );
        return ok({
          id: opened.value.state.id,
          status: 'open',
          version: opened.value.state.version,
        });
      },
    );
  }
}
