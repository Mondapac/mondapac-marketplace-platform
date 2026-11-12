import { err, ok } from '@mondapac/shared-kernel';
import type { AttributeValues, ContentHash, MarketContext, Result } from '@mondapac/shared-kernel';
import type { Product } from '../../domain/product';
import type { ProductTypeHandler, VariantDraft } from '../../domain/product-type-handler';
import type { RevisionContent } from '../../domain/revision-content';
import { freezeWorkingCopy, type FreezeIssue } from '../../domain/revision-freeze';
import { chooseAxes } from '../../domain/variant-axes';
import { buildVariantLabels } from '../../domain/variant-labels';
import type { WorkingCopy } from '../../domain/working-copy';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { AttributeValueSuggestionStore } from '../ports/attribute-value-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductImageRepository } from '../ports/product-image.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import { revisionContentHash } from './revision-content-hash';

/** A place the draft is not ready, from any of the checks. Codes and paths only, never a value. */
export interface RevisionIssue {
  readonly path: string;
  readonly code: string;
}

export type FreezeRevisionFailure =
  | { readonly code: 'revision.schema-unavailable' }
  | { readonly code: 'revision.type-unknown' }
  | { readonly code: 'revision.not-ready'; readonly issues: readonly RevisionIssue[] };

export interface FrozenRevision {
  readonly content: RevisionContent;
  readonly contentHash: ContentHash;
}

export interface FreezeRevisionDependencies {
  readonly attributes: AttributeRepository;
  readonly policy: CatalogMarketPolicy;
  /** The registered handler of a product type, or undefined. */
  readonly handlerFor: (typeCode: string) => ProductTypeHandler | undefined;
  /** The photo library; without it a draft that lists photos is not ready. */
  readonly images?: ProductImageRepository;
  /**
   * The revisions, to read the axes of the published one (variants V3: the axes of a published
   * product are locked). Without it the lock is not checked.
   */
  readonly revisions?: Pick<ProductRevisionRepository, 'find'>;
  /**
   * The sellers' value suggestions (attributes A5): a required field that is empty because its
   * suggestion is still open is reported as `attribute.suggestion-pending`, not `attribute.required`.
   */
  readonly suggestions?: AttributeValueSuggestionStore;
}

/**
 * Freezes a working copy into the immutable content of a revision (catalog design 2.3 M-2, 4.2 row
 * 1; slice 4c-5b): an internal service of the submit use cases, not a use case itself, so it
 * declares no access rule. The caller has already loaded the product under its ownership check and
 * the working copy of that product, inside the open unit. Everything that decides what is frozen
 * comes from stored state and Market configuration, never from the request:
 *
 * 1. the schema is built from the product's family (published revisions), so `schemaRef` is the
 *    server's, not the draft's;
 * 2. the product type's handler (the registry, by the product's type) validates the attribute
 *    values and, for an options product, the variant option combinations;
 * 3. the shape checks of `freezeWorkingCopy` (default-locale name, categories, tax category from
 *    the Market list, live variants, locales of the Market);
 * 4. the content hash.
 *
 * It writes nothing: the submit use case stores the revision and calls `Product.submitRevision`.
 * The issues of the shape checks and the attribute checks are returned together; the variant option
 * checks run once the shape is sound (they read the frozen variants), so a seller may see them in a
 * second round.
 */
export class FreezeRevision {
  constructor(private readonly deps: FreezeRevisionDependencies) {}

  async freeze(
    market: MarketContext,
    product: Product,
    copy: WorkingCopy,
  ): Promise<Result<FrozenRevision, FreezeRevisionFailure>> {
    const state = product.state;
    // Defence in depth: the caller loaded both under the ownership check, in this unit.
    if (state.marketId !== market.marketId || copy.productId !== state.id) {
      throw new Error('FreezeRevision: the product and the working copy do not belong together');
    }
    const handler = this.deps.handlerFor(state.typeCode);
    if (handler === undefined || handler.variantModel !== state.variantModel) {
      return err({ code: 'revision.type-unknown' });
    }
    const schema = await this.deps.attributes.loadSchema(market, state.familyCode);
    if (schema === null) return err({ code: 'revision.schema-unavailable' });

    const locales = this.deps.policy.locales(market);
    const maxVariants = this.deps.policy.maxVariantsPerProduct(market);
    const maxOptionAttributes = this.deps.policy.maxVariantAttributes(market);
    // The axes of a configurable product (V3): the draft's `variantAxes`, else every variant
    // attribute of the feature set. A Simple product has none.
    const axesIssues: RevisionIssue[] = [];
    let variantSchema = schema;
    if (state.variantModel === 'options') {
      const raw = copy.content['variantAxes'];
      const requested =
        Array.isArray(raw) && raw.every((item) => typeof item === 'string') ? raw : undefined;
      const chosen = chooseAxes(
        schema,
        requested,
        maxOptionAttributes,
        await this.#publishedAxes(market, product),
      );
      if (chosen.ok) variantSchema = chosen.schema;
      else axesIssues.push(...chosen.issues);
    }
    const frozen = freezeWorkingCopy({
      content: copy.content,
      defaultLocale: locales.default,
      supportedLocales: locales.supported,
      taxCategoryCodes: this.deps.policy.taxCategoryCodes(market),
      variantModel: state.variantModel,
      liveVariantIds: product.liveVariants.map((variant) => variant.id),
      maxVariants,
      labelsFor: (optionValues) =>
        buildVariantLabels(variantSchema, optionValues, locales.supported),
      schemaRef: {
        familyRevisionId: schema.schemaRef.familyRevisionId,
        definitionRevisionIds: schema.schemaRef.definitionRevisionIds,
      },
      contentSchemaVersion: copy.contentSchemaVersion,
    });

    const issues: RevisionIssue[] = frozen.ok ? [...axesIssues] : [...frozen.error, ...axesIssues];
    const rawValues = copy.content['attributeValues'];
    // The handler checks every value's type; a non-object is read as no values.
    const values = (
      typeof rawValues === 'object' && rawValues !== null ? rawValues : {}
    ) as AttributeValues;
    // The validator reads the first locale as the default, so the default goes first.
    const ordered = [locales.default, ...locales.supported.filter((l) => l !== locales.default)];
    const attributes = handler.validateAttributes(schema, values, ordered);
    if (!attributes.ok) {
      const pending =
        this.deps.suggestions === undefined
          ? new Set<string>()
          : await this.deps.suggestions.openAttributeCodesOfProduct(market, state.id);
      issues.push(
        ...attributes.error.map((issue) => ({
          path: issue.path,
          code:
            issue.code === 'attribute.required' && pending.has(issue.path)
              ? 'attribute.suggestion-pending'
              : issue.code,
        })),
      );
    }
    if (frozen.ok && axesIssues.length === 0) {
      // A Simple product's one variant carries no options; the handler still sees it (CC2).
      const drafts: VariantDraft[] = frozen.value.variants.map((variant) => ({
        optionValues: variant.optionValues,
      }));
      const variants = handler.validateVariants(
        variantSchema,
        drafts,
        maxVariants,
        maxOptionAttributes,
      );
      if (!variants.ok) {
        issues.push(...variants.issues.map((issue) => ({ path: issue.path, code: issue.code })));
      }
    }
    if (frozen.ok && frozen.value.imageIds.length > 0) {
      // Only clean photos of this product join a revision (the database repeats the rule).
      const usable =
        this.deps.images === undefined
          ? new Set<string>()
          : await this.deps.images.cleanIdsOf(market, state.id, frozen.value.imageIds);
      frozen.value.imageIds.forEach((imageId, index) => {
        if (!usable.has(imageId)) issues.push({ path: `imageIds.${index}`, code: 'unavailable' });
      });
    }
    if (issues.length > 0 || !frozen.ok) return err({ code: 'revision.not-ready', issues });
    return ok({ content: frozen.value, contentHash: revisionContentHash(frozen.value) });
  }

  /** The axes the published revision varies on, or null for a product with none (no lock). */
  async #publishedAxes(market: MarketContext, product: Product): Promise<readonly string[] | null> {
    const published = product.state.publishedRevisionId;
    if (published === null || this.deps.revisions === undefined) return null;
    const revision = await this.deps.revisions.find(market, product.state.id, published);
    if (revision === null) return null;
    const axes = new Set<string>();
    for (const variant of revision.content.variants) {
      for (const code of Object.keys(variant.optionValues)) axes.add(code);
    }
    return axes.size === 0 ? null : [...axes];
  }
}

export type { FreezeIssue };
