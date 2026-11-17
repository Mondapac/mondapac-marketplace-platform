import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { AttributeDefinition } from '../../domain/attribute-definition';
import type { Product } from '../../domain/product';
import { optionKeyOf } from '../../domain/revision-freeze';
import type { VariantRequest } from '../../domain/variant-request';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';

// What the use cases of the variant requests share (variants plan, package V7): the id of a
// request from a route, the facts of a product's variants a request is checked against, and the
// words that describe the option values to a person.

export function requestIdOf(raw: unknown): Id<'VariantRequest'> | null {
  const parsed = typeof raw === 'string' ? parseId<'VariantRequest'>(raw) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/** The version the admin saw. */
export function requestVersionOf(raw: unknown): Result<number, ValidationFailure> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 2_147_483_647) {
    return invalid('version', 'type');
  }
  return ok(raw);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((item) => typeof item === 'string');

export interface LiveVariant {
  readonly variantId: Id<'Variant'>;
  readonly variantNo: number;
  /** Null while the variant is only a draft row without option values. */
  readonly optionValues: Readonly<Record<string, string>> | null;
}

export interface ProductVariantFacts {
  readonly product: Product;
  readonly productCode: string;
  readonly familyCode: string;
  /** The variant attribute codes the product varies on, sorted. */
  readonly axes: readonly string[];
  /** The variants that are not retired, with the option values the draft or the revision gives. */
  readonly live: readonly LiveVariant[];
  /** The option key of each live variant that has option values. */
  readonly liveKeys: ReadonlyMap<string, Id<'Variant'>>;
}

export type ProductFactsFailure =
  /** Not a published PLATFORM product, or one that is not Configurable. */
  | { readonly code: 'variant-request.product-unavailable' }
  | { readonly code: 'variant-request.not-configurable' };

export interface ProductFactsDependencies {
  readonly products: ProductRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly revisions: ProductRevisionRepository;
}

/**
 * The variants of one PLATFORM product as a request is checked: the axes the product varies on
 * (those of its published variants, once published) and the option values of each variant that is
 * not retired. A variant the draft changed is read from the draft, else from the published
 * revision. Runs in the open unit of the caller.
 */
export async function loadProductVariantFacts(
  deps: ProductFactsDependencies,
  market: MarketContext,
  productId: Id<'Product'>,
): Promise<Result<ProductVariantFacts, ProductFactsFailure>> {
  const product = await deps.products.findById(market, productId);
  if (product === null) return err({ code: 'variant-request.product-unavailable' });
  const { state } = product;
  if (state.scope !== 'PLATFORM' || state.status !== 'published') {
    return err({ code: 'variant-request.product-unavailable' });
  }
  if (state.variantModel !== 'options') return err({ code: 'variant-request.not-configurable' });
  const published =
    state.publishedRevisionId === null
      ? null
      : await deps.revisions.find(market, state.id, state.publishedRevisionId);
  const copy = await deps.workingCopies.find(market, state.id);

  const optionsOf = new Map<string, Record<string, string>>();
  for (const variant of published?.content.variants ?? []) {
    optionsOf.set(variant.variantId, { ...variant.optionValues });
  }
  const draftVariants = copy?.content['variants'];
  for (const entry of Array.isArray(draftVariants) ? draftVariants : []) {
    if (!isObject(entry) || typeof entry['variantId'] !== 'string') continue;
    const values = entry['optionValues'];
    if (isStringMap(values)) optionsOf.set(entry['variantId'], { ...values });
  }
  const live: LiveVariant[] = product.liveVariants.map((variant) => ({
    variantId: variant.id,
    variantNo: variant.variantNo,
    optionValues: optionsOf.get(variant.id) ?? null,
  }));
  const liveKeys = new Map<string, Id<'Variant'>>();
  for (const variant of live) {
    if (variant.optionValues !== null && Object.keys(variant.optionValues).length > 0) {
      liveKeys.set(optionKeyOf(variant.optionValues), variant.variantId);
    }
  }
  // The axes are those of the published variants (they stay as published); a product with none yet
  // takes the axes its draft names.
  const publishedAxes = new Set(
    (published?.content.variants ?? []).flatMap((variant) => Object.keys(variant.optionValues)),
  );
  const draftAxes = copy?.content['variantAxes'];
  const axes =
    publishedAxes.size > 0
      ? [...publishedAxes]
      : Array.isArray(draftAxes)
        ? draftAxes.filter((axis): axis is string => typeof axis === 'string')
        : [];
  if (axes.length === 0) return err({ code: 'variant-request.not-configurable' });
  return ok({
    product,
    productCode: state.productCode,
    familyCode: state.familyCode,
    axes: axes.sort(),
    live,
    liveKeys,
  });
}

export interface OptionDescription {
  readonly attributeCode: string;
  readonly attributeName: string;
  readonly optionCode: string;
  readonly optionLabel: string;
}

/** The definitions read so far in one call, by attribute code. */
export type DefinitionCache = Map<string, AttributeDefinition | null>;

export interface DescribeDependencies {
  readonly attributes: AttributeRepository;
  readonly attributeStore: AttributeDefinitionStore;
}

/**
 * Names for the option values of a request in one locale: the attribute's name and the option's
 * label, else their codes. Runs in the open unit of the caller.
 */
export async function describeOptions(
  deps: DescribeDependencies,
  market: MarketContext,
  locale: string,
  values: Readonly<Record<string, string>>,
  cache: DefinitionCache,
): Promise<readonly OptionDescription[]> {
  const out: OptionDescription[] = [];
  for (const attributeCode of Object.keys(values).sort()) {
    const optionCode = values[attributeCode] ?? '';
    if (!cache.has(attributeCode)) {
      const id = await deps.attributes.definitionIdByCode(market, attributeCode);
      cache.set(attributeCode, id === null ? null : await deps.attributeStore.findById(market, id));
    }
    const definition = cache.get(attributeCode) ?? null;
    const option = definition?.state.options.find((candidate) => candidate.code === optionCode);
    out.push({
      attributeCode,
      attributeName: definition?.state.names[locale] ?? attributeCode,
      optionCode,
      optionLabel: option?.labels[locale] ?? optionCode,
    });
  }
  return out;
}

/** `Size: L, Colour: Red` for a mail. */
export const describedAs = (options: readonly OptionDescription[]): string =>
  options.map((option) => `${option.attributeName}: ${option.optionLabel}`).join(', ');

/** What a decision answers: the new state of the request. */
export interface VariantRequestDecisionView {
  readonly id: string;
  readonly status: 'approved' | 'mapped' | 'declined';
  readonly version: number;
  readonly resolvedVariantId: string | null;
}

export function decisionViewOf(request: VariantRequest): VariantRequestDecisionView {
  const { id, status, version, resolvedVariantId } = request.state;
  if (status === 'open') throw new Error('decisionViewOf: the request is still open');
  return { id, status, version, resolvedVariantId };
}
