import { validateAttributeValues } from '@mondapac/shared-kernel';
import type { AttributeSchema, AttributeValues, MarketContext } from '@mondapac/shared-kernel';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { PublishedProductValues } from '../ports/product-details-gap.reader';
import type { ProductFamilyResolver } from './product-family-resolver';

/** What one published product lacks, judged as its next submit will be. */
export interface MissingDetailsVerdict {
  /** The feature set it was judged against. */
  readonly featureSetCode: string;
  /** Codes of the required attributes with no value, in the feature set's order; empty when complete. */
  readonly missing: readonly string[];
}

/**
 * The rule of the report "Products missing required details" (attributes A4, decision ت۷), shared
 * by the report and the "Email sellers" action so both say the same. A product is judged against
 * the feature set its published revision's primary category holds now (CAT-10), or the one its
 * revision was frozen under when that cannot be resolved, with the submit's own rule
 * (`validateAttributeValues`: a localizable text needs its default-locale value). One judge per
 * call: it caches the schemas it read. Runs inside the caller's (read-only) unit.
 */
export class MissingDetailsJudge {
  readonly #schemas = new Map<string, AttributeSchema | null>();

  private constructor(
    private readonly market: MarketContext,
    private readonly attributes: AttributeRepository,
    private readonly session: Awaited<ReturnType<ProductFamilyResolver['open']>>,
    private readonly ordered: readonly string[],
  ) {}

  static async open(
    market: MarketContext,
    deps: {
      readonly attributes: AttributeRepository;
      readonly policy: CatalogMarketPolicy;
      readonly familyResolver: ProductFamilyResolver;
    },
  ): Promise<MissingDetailsJudge> {
    const locales = deps.policy.locales(market);
    // The validator reads the first locale as the default.
    const ordered = [locales.default, ...locales.supported.filter((l) => l !== locales.default)];
    const session = await deps.familyResolver.open(market);
    return new MissingDetailsJudge(market, deps.attributes, session, ordered);
  }

  /** The verdict, or null when the product's feature set cannot be read (it is not judged). */
  async judge(product: PublishedProductValues): Promise<MissingDetailsVerdict | null> {
    const resolved = await this.session.resolve(product.primaryCategoryId);
    const featureSetCode = resolved.ok ? resolved.familyCode : product.revisionFamilyCode;
    if (!this.#schemas.has(featureSetCode)) {
      this.#schemas.set(
        featureSetCode,
        await this.attributes.loadSchema(this.market, featureSetCode),
      );
    }
    const schema = this.#schemas.get(featureSetCode) ?? null;
    if (schema === null) return null;
    const raw = product.attributeValues;
    const values = (typeof raw === 'object' && raw !== null ? raw : {}) as AttributeValues;
    const checked = validateAttributeValues(schema, values, this.ordered);
    if (checked.ok) return { featureSetCode, missing: [] };
    const missing = [
      ...new Set(
        checked.error
          .filter((issue) => issue.code === 'attribute.required')
          // A localizable text reports `code.locale`; attribute codes hold no dot.
          .map((issue) => issue.path.split('.')[0] ?? issue.path),
      ),
    ];
    return { featureSetCode, missing };
  }

  /** Feature sets this judge could not read, sorted. */
  unreadable(): readonly string[] {
    return [...this.#schemas.entries()]
      .filter(([, schema]) => schema === null)
      .map(([code]) => code)
      .sort();
  }
}
