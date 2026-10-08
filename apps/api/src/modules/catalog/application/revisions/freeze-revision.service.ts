import { err, ok } from '@mondapac/shared-kernel';
import type { AttributeValues, ContentHash, MarketContext, Result } from '@mondapac/shared-kernel';
import type { Product } from '../../domain/product';
import type { ProductTypeHandler, VariantDraft } from '../../domain/product-type-handler';
import type { RevisionContent } from '../../domain/revision-content';
import { freezeWorkingCopy, type FreezeIssue } from '../../domain/revision-freeze';
import type { WorkingCopy } from '../../domain/working-copy';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
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
    const handler = this.deps.handlerFor(state.typeCode);
    if (handler === undefined) return err({ code: 'revision.type-unknown' });
    const schema = await this.deps.attributes.loadSchema(market, state.familyCode);
    if (schema === null) return err({ code: 'revision.schema-unavailable' });

    const locales = this.deps.policy.locales(market);
    const maxVariants = this.deps.policy.maxVariantsPerProduct(market);
    const frozen = freezeWorkingCopy({
      content: copy.content,
      defaultLocale: locales.default,
      supportedLocales: locales.supported,
      taxCategoryCodes: this.deps.policy.taxCategoryCodes(market),
      variantModel: state.variantModel,
      liveVariantIds: product.liveVariants.map((variant) => variant.id),
      maxVariants,
      schemaRef: {
        familyRevisionId: schema.schemaRef.familyRevisionId,
        definitionRevisionIds: schema.schemaRef.definitionRevisionIds,
      },
      contentSchemaVersion: copy.contentSchemaVersion,
    });

    const issues: RevisionIssue[] = frozen.ok ? [] : [...frozen.error];
    const rawValues = copy.content['attributeValues'];
    // The handler checks every value's type; a non-object is read as no values.
    const values = (
      typeof rawValues === 'object' && rawValues !== null ? rawValues : {}
    ) as AttributeValues;
    // The validator reads the first locale as the default, so the default goes first.
    const ordered = [locales.default, ...locales.supported.filter((l) => l !== locales.default)];
    const attributes = handler.validateAttributes(schema, values, ordered);
    if (!attributes.ok) {
      issues.push(...attributes.error.map((issue) => ({ path: issue.path, code: issue.code })));
    }
    if (frozen.ok && state.variantModel === 'options') {
      const drafts: VariantDraft[] = frozen.value.variants.map((variant) => ({
        optionValues: variant.optionValues,
      }));
      const variants = handler.validateVariants(schema, drafts, maxVariants);
      if (!variants.ok) {
        issues.push(...variants.issues.map((issue) => ({ path: issue.path, code: issue.code })));
      }
    }
    if (issues.length > 0 || !frozen.ok) return err({ code: 'revision.not-ready', issues });
    return ok({ content: frozen.value, contentHash: revisionContentHash(frozen.value) });
  }
}

export type { FreezeIssue };
