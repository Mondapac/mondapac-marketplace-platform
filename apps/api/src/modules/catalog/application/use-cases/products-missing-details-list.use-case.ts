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
import {
  heldKeys,
  pageWindow,
  rowActions,
  type ListPagingMode,
  type PermissionProbe,
  type RowActionRule,
} from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_EDIT, CATALOG_ATTRIBUTE_VIEW } from '../../contracts/permissions';
import { closedInput, invalid, type ValidationFailure } from '../brands/brand-views';
import { readCatalogListInput } from '../lists/catalog-list-input';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { MissingDetailsEmailStore } from '../ports/missing-details-email.store';
import type { ProductDetailsGapReader } from '../ports/product-details-gap.reader';

/** Rows one page may return. */
export const GAP_PAGE_DEFAULT = 50;
export const GAP_PAGE_MAX = 100;
/** Products one cursor call reads at most; a longer scan continues from `nextAfterId`. */
export const GAP_SCAN_MAX = 2000;
/**
 * Products a page read scans at most. The gaps are judged in memory against the feature sets, so a
 * numbered page reads the Market's published products up to this cap; past it the answer says
 * `complete: false` and `total` counts what was read.
 */
export const GAP_PAGE_SCAN_MAX = 10_000;
export const GAP_MAX_PAGE = 100;
export const GAP_SORTS = ['code', 'name', 'family', 'missing'] as const;
const GAP_BATCH = 200;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProductsMissingDetailsListInput {
  readonly afterId?: unknown;
  readonly limit?: unknown;
  readonly sellerId?: unknown;
  readonly familyCode?: unknown;
  /** Search in the product code and name (contains, any case). */
  readonly q?: unknown;
  readonly search?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly paging?: unknown;
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
  /** The row actions of the Actions menu the caller may run: `open-product`, `email-seller`. */
  readonly actions: readonly string[];
}

/** What each row action needs (the plan's table, row 6); a PLATFORM product has no seller to mail. */
export const MISSING_DETAILS_ACTION_RULES: readonly RowActionRule<
  Pick<MissingDetailsItem, 'sellerId'>
>[] = [
  { id: 'open-product', permission: null },
  {
    id: 'email-seller',
    permission: CATALOG_ATTRIBUTE_EDIT.key,
    when: (row) => row.sellerId !== null,
  },
];

export interface ProductsMissingDetailsListOutput {
  readonly items: readonly MissingDetailsItem[];
  /** The `afterId` of the next call; null when the whole Market has been read (always null on a page read). */
  readonly nextAfterId: string | null;
  /** How many published products this call read. */
  readonly scanned: number;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  /** The gaps found over all pages; null in `prev-next` mode and on a cursor read. */
  readonly total: number | null;
  /** False when a page read hit the scan cap before the end of the Market: `total` is then partial. */
  readonly complete: boolean;
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
  /** The gate's answer to "does the caller hold `catalog.attribute.edit`", for `email-seller`. */
  readonly attributeEditProbe: PermissionProbe;
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
    const body = closedInput(input, [
      'afterId',
      'limit',
      'sellerId',
      'familyCode',
      'q',
      'search',
      'sort',
      'direction',
      'page',
      'pageSize',
      'paging',
    ]);
    if (!body.ok) return body;
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
    const { sellerId: _s, familyCode: _f, ...rest } = body.value;
    void _s;
    void _f;
    const read = readCatalogListInput(rest, {
      sorts: GAP_SORTS,
      defaultSort: 'code',
      defaultDirection: (sort) => (sort === 'missing' ? 'desc' : 'asc'),
      pageDefault: GAP_PAGE_DEFAULT,
      pageMax: GAP_PAGE_MAX,
      maxPage: GAP_MAX_PAGE,
      cursorIdOf: (value) => (typeof value === 'string' && ID.test(value) ? value : null),
    });
    if (!read.ok) return read;
    const text = read.value.q === null ? null : read.value.q.toLowerCase();

    const { market } = context;
    const locales = this.deps.policy.locales(market);
    // The validator reads the first locale as the default.
    const ordered = [locales.default, ...locales.supported.filter((l) => l !== locales.default)];
    const unit = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.#scan(
            market,
            read.value.mode === 'cursor'
              ? {
                  afterId: read.value.afterId,
                  sellerId,
                  familyCode,
                  text,
                  limit: read.value.limit,
                  all: false,
                }
              : { afterId: null, sellerId, familyCode, text, limit: Infinity, all: true },
            locales.default,
            ordered,
          ),
        ),
      { readOnly: true },
    );
    if (!unit.ok) return err({ code: 'access.unavailable' });
    const scanned = unit.value;
    let items = scanned.items;
    let paging: ListPagingMode = 'prev-next';
    let pageNo = 1;
    let pageSize = read.value.mode === 'cursor' ? read.value.limit : items.length;
    let hasNext = scanned.nextAfterId !== null;
    let total: number | null = null;
    if (read.value.mode === 'page') {
      const { paged } = read.value;
      const sign = paged.direction === 'asc' ? 1 : -1;
      const key = (item: (typeof items)[number]): string | number =>
        paged.sort === 'name'
          ? (item.name ?? '').toLowerCase()
          : paged.sort === 'family'
            ? item.featureSetCode
            : paged.sort === 'missing'
              ? item.missing.length
              : item.productCode;
      const sorted = [...items].sort(
        (a, b) =>
          sign * (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) ||
          (a.productCode < b.productCode ? -1 : a.productCode > b.productCode ? 1 : 0),
      );
      const window = pageWindow(paged);
      items = sorted.slice(window.offset, window.offset + paged.pageSize);
      pageNo = paged.page;
      pageSize = paged.pageSize;
      paging = paged.paging;
      hasNext = window.offset + paged.pageSize < sorted.length;
      total = paged.paging === 'pages' ? sorted.length : null;
    }
    const emailed = await this.#lastEmailed(market, items);
    const granted = await heldKeys(context, {
      [CATALOG_ATTRIBUTE_EDIT.key]: this.deps.attributeEditProbe,
    });
    return ok({
      items: items.map((item) => ({
        ...item,
        lastEmailedAt: emailed.get(`${item.sellerId}/${item.productId}`) ?? null,
        actions: rowActions(item, MISSING_DETAILS_ACTION_RULES, granted),
      })),
      nextAfterId: read.value.mode === 'cursor' ? scanned.nextAfterId : null,
      scanned: scanned.scanned,
      unreadableFeatureSets: scanned.unreadableFeatureSets,
      page: pageNo,
      pageSize,
      paging,
      hasNext,
      total,
      complete: scanned.complete,
    });
  }

  async #scan(
    market: MarketContext,
    filter: {
      readonly afterId: string | null;
      readonly sellerId: string | null;
      readonly familyCode: string | null;
      /** Lower-cased search in the product code and name, or null. */
      readonly text: string | null;
      /** Rows wanted (a cursor read); `Infinity` with `all`. */
      readonly limit: number;
      /** A page read: scan on to the end of the Market or {@link GAP_PAGE_SCAN_MAX}. */
      readonly all: boolean;
    },
    locale: string,
    ordered: readonly string[],
  ): Promise<{
    readonly items: readonly Omit<MissingDetailsItem, 'lastEmailedAt' | 'actions'>[];
    readonly nextAfterId: string | null;
    readonly scanned: number;
    readonly unreadableFeatureSets: readonly string[];
    readonly complete: boolean;
  }> {
    // The feature set a product is judged against is the one its published revision's primary
    // category holds now: what its next submit will ask (CAT-10). When that cannot be resolved the
    // product is judged against the feature set its revision was frozen under.
    const session = await this.deps.familyResolver.open(market);
    const schemas = new Map<string, AttributeSchema | null>();
    const items: Omit<MissingDetailsItem, 'lastEmailedAt' | 'actions'>[] = [];
    const scanMax = filter.all ? GAP_PAGE_SCAN_MAX : GAP_SCAN_MAX;
    let cursor = filter.afterId;
    let scanned = 0;
    let exhausted = false;
    while ((filter.all || items.length < filter.limit) && scanned < scanMax) {
      const requested = Math.min(GAP_BATCH, scanMax - scanned);
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
      let pageFull = false;
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
        if (
          filter.text !== null &&
          !product.productCode.toLowerCase().includes(filter.text) &&
          !(product.name ?? '').toLowerCase().includes(filter.text)
        ) {
          continue;
        }
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
        if (!filter.all && items.length >= filter.limit) {
          // The page is full; the rest of this batch is read by the next call.
          exhausted = index === batch.length - 1 && batch.length < requested;
          pageFull = true;
          break;
        }
      }
      // A short batch is the end of the Market: no empty read is needed to know it.
      if (!pageFull && batch.length < requested) exhausted = true;
    }
    if (filter.all && !exhausted && scanned >= scanMax) {
      // The cap was reached on a full batch: one row past it tells whether the Market ended there.
      const probe = await this.deps.detailsGapReader.published(market, {
        afterId: cursor,
        sellerId: filter.sellerId,
        limit: 1,
        locale,
      });
      exhausted = probe.length === 0;
    }
    return {
      items,
      nextAfterId: exhausted ? null : cursor,
      scanned,
      unreadableFeatureSets: [...schemas.entries()]
        .filter(([, schema]) => schema === null)
        .map(([code]) => code)
        .sort(),
      complete: exhausted,
    };
  }

  /**
   * "Last emailed" (A4-4): the latest "Email sellers" request of the row's seller and product, when
   * it was sent. PLATFORM products have no seller and are never emailed.
   */
  async #lastEmailed(
    market: MarketContext,
    items: readonly { readonly sellerId: string | null; readonly productId: string }[],
  ): Promise<Map<string, string>> {
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
    return sentAt;
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
