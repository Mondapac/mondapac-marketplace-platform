import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  AttributeValueSuggestion,
  MAX_OPEN_SUGGESTIONS_PER_SELLER,
  tidySuggestionText,
  type SuggestionRefusal,
} from '../../domain/attribute-value-suggestion';
import { AttributeValueSuggestedAudit } from '../../domain/audit';
import { takesSellerValues } from '../attributes/attribute-suggestions';
import { sellerOf } from '../own-reads/own-reads.shared';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { AttributeValueSuggestionStore } from '../ports/attribute-value-suggestion.store';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';

export interface OwnAttributeValueSuggestInput {
  readonly productId: unknown;
  readonly attributeCode: unknown;
  readonly label: unknown;
}

export interface OwnAttributeValueSuggestOutput {
  readonly id: string;
  readonly attributeCode: string;
  readonly status: 'open';
  readonly version: number;
}

export type OwnAttributeValueSuggestFailure =
  | SuggestionRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'product.not-editable' }
  | { readonly code: 'attribute.not-suggestable' }
  /** The value is already on the list: the seller should pick it. */
  | { readonly code: 'suggestion.value-exists' }
  | { readonly code: 'suggestion.already-open' }
  | { readonly code: 'suggestion.limit-reached'; readonly max: number }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnAttributeValueSuggestDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly attributes: AttributeRepository;
  readonly attributeStore: AttributeDefinitionStore;
  readonly suggestions: AttributeValueSuggestionStore;
  readonly eligibility: SellerEligibilityReader;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A seller may suggest on a product that is still theirs to work on. */
const SUGGESTING_STATUSES: ReadonlySet<string> = new Set(['draft', 'unpublished', 'published']);

const sameLabel = (a: string, b: string): boolean =>
  a.normalize('NFKC').toLocaleLowerCase('en') === b.normalize('NFKC').toLocaleLowerCase('en');

/**
 * `own-attribute-value.suggest` (attributes plan, package A5): a seller asks for a value that a
 * select or multi-select field of their own product does not offer. Rule: the key
 * `catalog.own-product.edit`, the seller population and a seller who may sell. The request names
 * the product, the field code and the text; the seller, Market and status come from stored state.
 * A product of another seller, a PLATFORM product and an unknown id answer a byte-identical
 * `product.not-found`. Only a published, select-like field that is not `material` takes a
 * suggestion (`attribute.not-suggestable`); a variant option (colour, size) does, so a seller can
 * ask for the option a variant needs (john, 5 Nov 2026). One open suggestion per product and field, at most {@link MAX_OPEN_SUGGESTIONS_PER_SELLER} open per seller, and not a
 * text the list already has. The text is the seller's own in the Market's default locale; it
 * reaches no buyer and no model, and an admin decides it. The product keeps the field empty
 * meanwhile (the submit says why when the field is required). One audit row, with ids only.
 */
export class OwnAttributeValueSuggest extends UseCase<
  OwnAttributeValueSuggestInput,
  OwnAttributeValueSuggestOutput,
  OwnAttributeValueSuggestFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-attribute-value-suggest',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnAttributeValueSuggest');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnAttributeValueSuggestDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnAttributeValueSuggestInput,
  ): Promise<Result<OwnAttributeValueSuggestOutput, OwnAttributeValueSuggestFailure>> {
    const result = await this.#suggest(context, input);
    this.#logger.log({
      msg: 'catalog.own-attribute-value-suggest',
      code: result.ok ? 'opened' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #suggest(
    context: CallContext,
    input: OwnAttributeValueSuggestInput,
  ): Promise<Result<OwnAttributeValueSuggestOutput, OwnAttributeValueSuggestFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (!(await this.deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const fail = (path: string, code: string): Result<never, OwnAttributeValueSuggestFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const productId =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (productId === null || !productId.ok) return fail('productId', 'format');
    if (
      typeof input.attributeCode !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(input.attributeCode)
    ) {
      return fail('attributeCode', 'format');
    }
    if (typeof input.label !== 'string' || [...input.label].length > 400) {
      return fail('label', 'type');
    }
    const attributeCode = input.attributeCode;
    const label = tidySuggestionText(input.label);
    const { market } = context;
    return this.deps.unitOfWork.run<
      OwnAttributeValueSuggestOutput,
      OwnAttributeValueSuggestFailure
    >(market, async () => {
      const { products, attributes, attributeStore, suggestions } = this.deps;
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
      const schema = await attributes.loadSchema(market, product.state.familyCode);
      if (schema === null) return err({ code: 'attribute.not-suggestable' } as const);
      const field = schema.fields.find((candidate) => candidate.code === attributeCode);
      if (
        field === undefined ||
        (field.dataType !== 'select' && field.dataType !== 'multi-select') ||
        field.material
      ) {
        return err({ code: 'attribute.not-suggestable' } as const);
      }
      const definitionId = await attributes.definitionIdByCode(market, attributeCode);
      const definition =
        definitionId === null ? null : await attributeStore.findById(market, definitionId);
      if (definition === null || !takesSellerValues(definition)) {
        return err({ code: 'attribute.not-suggestable' } as const);
      }

      const opened = AttributeValueSuggestion.open({
        id: this.deps.ids.next<'AttributeValueSuggestion'>(),
        marketId: market.marketId,
        definitionId: definition.state.id,
        sellerId,
        productId: product.state.id,
        label,
        now: this.deps.clock.now(),
      });
      if (!opened.ok) return err(opened.error);
      if (
        definition.state.options.some((option) =>
          Object.values(option.labels).some((text) => sameLabel(text, label)),
        )
      ) {
        return err({ code: 'suggestion.value-exists' } as const);
      }
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
        AttributeValueSuggestedAudit.entry(opened.value.state.id, {
          after: { definitionId: definition.state.id, productId: product.state.id },
        }),
      );
      return ok({
        id: opened.value.state.id,
        attributeCode,
        status: 'open',
        version: opened.value.state.version,
      });
    });
  }
}
