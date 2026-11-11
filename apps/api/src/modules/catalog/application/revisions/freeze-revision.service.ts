import { err, ok } from '@mondapac/shared-kernel';
import type {
  AttributeSchema,
  AttributeValues,
  ContentHash,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import type { Product } from '../../domain/product';
import type { ProductTypeHandler, VariantDraft } from '../../domain/product-type-handler';
import type { RevisionContent } from '../../domain/revision-content';
import { freezeWorkingCopy, type FreezeIssue } from '../../domain/revision-freeze';
import { chooseAxes } from '../../domain/variant-axes';
import { buildVariantLabels } from '../../domain/variant-labels';
import type { WorkingCopy } from '../../domain/working-copy';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { AttributeValueSuggestionStore } from '../ports/attribute-value-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductImageRepository } from '../ports/product-image.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { TopicBrief, TopicReader } from '../ports/topic.reader';
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
  /** The feature set the content was frozen under: the one its primary category holds (CAT-10). */
  readonly familyCode: string;
  /** The product type the content was frozen with: the row's, whose handler validated it (M-9). */
  readonly typeCode: string;
}

export interface FreezeRevisionDependencies {
  readonly attributes: AttributeRepository;
  /** The feature set of a primary category (attributes plan A4, decision ت۱۰). */
  readonly familyResolver: ProductFamilyResolver;
  readonly policy: CatalogMarketPolicy;
  /** The registered handler of a product type, or undefined. */
  readonly handlerFor: (typeCode: string) => ProductTypeHandler | undefined;
  /** The photo library; without it a draft that lists photos is not ready. */
  readonly images?: ProductImageRepository;
  /**
   * The revisions, to read the axes of the published one (variants V3: the axes of a published
   * product are locked). Required: the lock fails closed, never unchecked.
   */
  readonly revisions: Pick<ProductRevisionRepository, 'find'>;
  /**
   * The sellers' value suggestions (attributes A5): a required field that is empty because its
   * suggestion is still open is reported as `attribute.suggestion-pending`, not `attribute.required`.
   */
  readonly suggestions?: AttributeValueSuggestionStore;
  /**
   * The topics, to check that each chosen topic exists in the Market and may be added (product tags
   * T2). Without it a draft that lists topics is not ready (fail closed).
   */
  readonly topics?: Pick<TopicReader, 'briefsOf'>;
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
    // The family follows the primary category (the first one listed) at every submit; a tree or
    // feature set that cannot be read fails closed, never to the product's old family.
    const rawCategories = copy.content['categoryIds'];
    const primaryCategoryId =
      Array.isArray(rawCategories) && typeof rawCategories[0] === 'string'
        ? rawCategories[0]
        : null;
    const resolved = await this.deps.familyResolver.resolve(market, primaryCategoryId);
    if (!resolved.ok) return err({ code: 'revision.schema-unavailable' });
    const familyCode = resolved.familyCode;
    const schema = await this.deps.attributes.loadSchema(market, familyCode);
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
    // Values of another feature set are kept in the working copy (a move back restores them) but
    // are not frozen: they are left out, not refused as unknown, only when the family changed.
    // This is done at every submit, not only after a move: a reject puts the column back on the
    // old feature set while the working copy still holds the new one's values, and a move back
    // must not meet them as unknown. A code that names no active definition of the Market stays
    // and is refused as unknown.
    const content = await this.#withoutOtherFamilyValues(market, copy.content, schema);
    const frozen = freezeWorkingCopy({
      content,
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

    // After a move to another feature set, an option the new set does not hold is named as such,
    // not as an unknown attribute: the seller must pick other options or move the product back.
    const moved = familyCode !== state.familyCode;
    const notInFamily = (issue: RevisionIssue): RevisionIssue =>
      moved && (issue.code === 'variants.axes-unknown' || issue.code === 'variants.option-unknown')
        ? { path: issue.path, code: 'variants.option-not-in-family' }
        : issue;
    const issues: RevisionIssue[] = (
      frozen.ok ? [...axesIssues] : [...frozen.error, ...axesIssues]
    ).map(notInFamily);
    const rawValues = content['attributeValues'];
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
        issues.push(
          ...variants.issues.map((issue) => notInFamily({ path: issue.path, code: issue.code })),
        );
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
    if (frozen.ok && frozen.value.topicIds.length > 0) {
      issues.push(...(await this.#topicIssues(market, product, frozen.value.topicIds)));
    }
    if (issues.length > 0 || !frozen.ok) return err({ code: 'revision.not-ready', issues });
    return ok({
      content: frozen.value,
      contentHash: revisionContentHash(frozen.value),
      familyCode,
      typeCode: state.typeCode,
    });
  }

  /**
   * A topic must exist in this Market (`unknown`: another Market's id is the same answer, never a
   * foreign key fault) and must not be archived, unless the published revision already carries it
   * (`archived`). Approval does not look again: the content hash ties the review to the content.
   */
  async #topicIssues(
    market: MarketContext,
    product: Product,
    topicIds: readonly string[],
  ): Promise<RevisionIssue[]> {
    if (this.deps.topics === undefined) {
      return topicIds.map((_, index) => ({ path: `topicIds.${index}`, code: 'unavailable' }));
    }
    const briefs = new Map<string, TopicBrief>(
      (await this.deps.topics.briefsOf(market, topicIds)).map((brief) => [brief.id, brief]),
    );
    const publishedId = product.state.publishedRevisionId;
    const published =
      publishedId === null || this.deps.revisions === undefined
        ? null
        : await this.deps.revisions.find(market, product.state.id, publishedId);
    const kept = new Set(published?.content.topicIds ?? []);
    const issues: RevisionIssue[] = [];
    topicIds.forEach((topicId, index) => {
      const brief = briefs.get(topicId);
      if (brief === undefined) issues.push({ path: `topicIds.${index}`, code: 'unknown' });
      else if (brief.status === 'archived' && !kept.has(topicId)) {
        issues.push({ path: `topicIds.${index}`, code: 'archived' });
      }
    });
    return issues;
  }

  /** The content with the values of other feature sets' attributes taken out (CAT-10). */
  async #withoutOtherFamilyValues(
    market: MarketContext,
    content: WorkingCopy['content'],
    schema: AttributeSchema,
  ): Promise<WorkingCopy['content']> {
    const raw = content['attributeValues'];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return content;
    const known = new Set(schema.fields.map((field) => field.code));
    const outside = Object.keys(raw).filter((code) => !known.has(code));
    if (outside.length === 0) return content;
    const defined = await this.deps.attributes.activeDefinitionCodes(market, outside);
    return {
      ...content,
      attributeValues: Object.fromEntries(
        Object.entries(raw).filter(([code]) => known.has(code) || !defined.has(code)),
      ),
    };
  }

  /** The axes the published revision varies on, or null for a product with none (no lock). */
  async #publishedAxes(market: MarketContext, product: Product): Promise<readonly string[] | null> {
    const published = product.state.publishedRevisionId;
    if (published === null) return null;
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
