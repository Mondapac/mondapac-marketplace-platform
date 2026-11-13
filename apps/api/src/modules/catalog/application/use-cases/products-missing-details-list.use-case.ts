import { Logger } from '@nestjs/common';
import { err, ok, validateAttributeValues } from '@mondapac/shared-kernel';
import type {
  AttributeSchema,
  AttributeValues,
  CallContext,
  Id,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_VIEW } from '../../contracts/permissions';
import { closedInput, invalid, type ValidationFailure } from '../brands/brand-views';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { MissingDetailsEmailStore } from '../ports/missing-details-email.store';
import type { ProductDetailsGapReader } from '../ports/product-details-gap.reader';

/** Rows one page may return. */
export const GAP_PAGE_DEFAULT = 50;
export const GAP_PAGE_MAX = 100;
/** Products one call reads at most; a longer scan continues from `nextAfterId`. */
export const GAP_SCAN_MAX = 2000;
const GAP_BATCH = 200;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProductsMissingDetailsListInput {
  readonly afterId?: unknown;
  readonly limit?: unknown;
  readonly sellerId?: unknown;
  readonly familyCode?: unknown;
}

export interface MissingDetailsItem {
  readonly productId: string;
  readonly productCode: string;
  readonly name: string | null;
  readonly sellerId: string | null;
  readonly featureSetCode: string;
  /** Codes of the required attributes with no value, in the feature set's order. */
  readonly missing: readonly string[];
  /**
   * When an "Email sellers" mail about it last went to its seller (ISO instant, A4-4); null when
   * never, or while a newer request for it waits (the store keeps the latest request only).
   */
  readonly lastEmailedAt: string | null;
}

export interface ProductsMissingDetailsListOutput {
  readonly items: readonly MissingDetailsItem[];
  /** The `afterId` of the next call; null when the whole Market has been read. */
  readonly nextAfterId: string | null;
  /** How many published products this call read. */
  readonly scanned: number;
  /** Feature sets that could not be read (unknown, archived or naming a missing attribute): their products are not judged. */
  readonly unreadableFeatureSets: readonly string[];
}

export type ProductsMissingDetailsListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface ProductsMissingDetailsListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly detailsGapReader: ProductDetailsGapReader;
  readonly attributes: AttributeRepository;
  readonly policy: CatalogMarketPolicy;
  readonly familyResolver: ProductFamilyResolver;
  readonly emailStore: MissingDetailsEmailStore;
}

/**
 * `catalog.products-missing-details-list` (attributes package A4, decision ت۷): the published
 * products whose published values leave a required attribute of their feature set empty, because
 * the feature set gained a required attribute after they were approved. Such a product stays on
 * sale; the seller is refused at the next submit until the field is filled. Judged with the same
 * rule as a submit (`validateAttributeValues`: a localizable text needs its default-locale
 * value), against the feature set's current published revision. Keyset-paged by product id; one
 * call reads at most {@link GAP_SCAN_MAX} products and returns `nextAfterId` to continue.
 * Rule: `catalog.attribute.view` and the admin population. One read-only unit.
 */
export class ProductsMissingDetailsList extends UseCase<
  ProductsMissingDetailsListInput,
  ProductsMissingDetailsListOutput,
  ProductsMissingDetailsListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.products-missing-details-list',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_VIEW.key] },
  };

  readonly #logger = new Logger('ProductsMissingDetailsList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductsMissingDetailsListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductsMissingDetailsListInput,
  ): Promise<Result<ProductsMissingDetailsListOutput, ProductsMissingDetailsListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.products-missing-details-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: ProductsMissingDetailsListInput,
  ): Promise<Result<ProductsMissingDetailsListOutput, ProductsMissingDetailsListFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input, ['afterId', 'limit', 'sellerId', 'familyCode']);
    if (!body.ok) return body;
    const afterId = optionalId(body.value['afterId']);
    if (afterId === undefined) return invalid('afterId', 'format');
    const sellerId = optionalId(body.value['sellerId']);
    if (sellerId === undefined) return invalid('sellerId', 'format');
    const rawFamily = body.value['familyCode'];
    let familyCode: string | null = null;
    if (rawFamily !== undefined && rawFamily !== null && rawFamily !== '') {
      if (typeof rawFamily !== 'string' || !CODE.test(rawFamily)) {
        return invalid('familyCode', 'format');
      }
      familyCode = rawFamily;
    }
    let limit = GAP_PAGE_DEFAULT;
    const rawLimit = body.value['limit'];
    if (rawLimit !== undefined && rawLimit !== null) {
      if (
        typeof rawLimit !== 'number' ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > GAP_PAGE_MAX
      ) {
        return invalid('limit', 'range');
      }
      limit = rawLimit;
    }

    const { market } = context;
    const locales = this.deps.policy.locales(market);
    // The validator reads the first locale as the default.
    const ordered = [locales.default, ...locales.supported.filter((l) => l !== locales.default)];
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.#scan(
            market,
            { afterId, sellerId, familyCode, limit },
            locales.default,
            ordered,
          ),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok(read.value);
  }

  async #scan(
    market: MarketContext,
    filter: {
      readonly afterId: string | null;
      readonly sellerId: string | null;
      readonly familyCode: string | null;
      readonly limit: number;
    },
    locale: string,
    ordered: readonly string[],
  ): Promise<ProductsMissingDetailsListOutput> {
    // The feature set a product is judged against is the one its published revision's primary
    // category holds now: what its next submit will ask (CAT-10). When that cannot be resolved the
    // product is judged against the feature set its revision was frozen under.
    const session = await this.deps.familyResolver.open(market);
    const schemas = new Map<string, AttributeSchema | null>();
    const items: Omit<MissingDetailsItem, 'lastEmailedAt'>[] = [];
    let cursor = filter.afterId;
    let scanned = 0;
    let exhausted = false;
    while (items.length < filter.limit && scanned < GAP_SCAN_MAX) {
      const requested = Math.min(GAP_BATCH, GAP_SCAN_MAX - scanned);
      const batch = await this.deps.detailsGapReader.published(market, {
        afterId: cursor,
        sellerId: filter.sellerId,
        limit: requested,
        locale,
      });
      if (batch.length === 0) {
        exhausted = true;
        break;
      }
      for (const [index, product] of batch.entries()) {
        const resolved = await session.resolve(product.primaryCategoryId);
        const familyCode = resolved.ok ? resolved.familyCode : product.revisionFamilyCode;
        if (!schemas.has(familyCode)) {
          schemas.set(familyCode, await this.deps.attributes.loadSchema(market, familyCode));
        }
        const schema = schemas.get(familyCode) ?? null;
        cursor = product.productId;
        scanned += 1;
        if (schema === null) continue;
        if (filter.familyCode !== null && familyCode !== filter.familyCode) continue;
        const missing = missingRequiredCodes(schema, product.attributeValues, ordered);
        if (missing.length > 0) {
          items.push({
            productId: product.productId,
            productCode: product.productCode,
            name: product.name,
            sellerId: product.ownerSellerId,
            featureSetCode: familyCode,
            missing,
          });
        }
        if (items.length >= filter.limit) {
          // The page is full; the rest of this batch is read by the next call.
          exhausted = index === batch.length - 1 && batch.length < requested;
          break;
        }
      }
    }
    const nextAfterId = exhausted ? null : cursor;
    // "Last emailed" (A4-4): the latest "Email sellers" request of the row's seller and product,
    // when it was sent. PLATFORM products have no seller and are never emailed.
    const pairs = items.flatMap((item) =>
      item.sellerId === null
        ? []
        : [{ sellerId: item.sellerId as Id<'Seller'>, productId: item.productId }],
    );
    const sentAt = new Map<string, string>();
    if (pairs.length > 0) {
      for (const record of await this.deps.emailStore.latest(market, pairs)) {
        if (record.state === 'sent' && record.settledAt !== null) {
          sentAt.set(`${record.sellerId}/${record.productId}`, record.settledAt.toString());
        }
      }
    }
    return {
      items: items.map((item) => ({
        ...item,
        lastEmailedAt: sentAt.get(`${item.sellerId}/${item.productId}`) ?? null,
      })),
      nextAfterId,
      scanned,
      unreadableFeatureSets: [...schemas.entries()]
        .filter(([, schema]) => schema === null)
        .map(([code]) => code)
        .sort(),
    };
  }
}

/**
 * The codes of the required attributes a product's published values leave empty, judged with the
 * same rule as a submit (`validateAttributeValues`) in the feature set's order. Shared with the
 * "Email sellers" request, which judges the products it names again on the server.
 */
export function missingRequiredCodes(
  schema: AttributeSchema,
  rawValues: unknown,
  orderedLocales: readonly string[],
): readonly string[] {
  const values = (
    typeof rawValues === 'object' && rawValues !== null ? rawValues : {}
  ) as AttributeValues;
  const checked = validateAttributeValues(schema, values, orderedLocales);
  if (checked.ok) return [];
  return [
    ...new Set(
      checked.error
        .filter((issue) => issue.code === 'attribute.required')
        // A localizable text reports `code.locale`; attribute codes hold no dot.
        .map((issue) => issue.path.split('.')[0] ?? issue.path),
    ),
  ];
}

/** `null` when absent, the id when well formed, `undefined` when malformed. */
function optionalId(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null;
  return typeof raw === 'string' && ID.test(raw) ? raw : undefined;
}
