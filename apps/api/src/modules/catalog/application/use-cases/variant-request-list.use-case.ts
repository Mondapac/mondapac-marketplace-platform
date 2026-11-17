import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  heldKeys,
  listPage,
  pageWindow,
  parseListQuery,
  rowActions,
  type ListPagingMode,
  type PermissionProbe,
  type RowActionRule,
} from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_PLATFORM_PRODUCT_EDIT,
  CATALOG_VARIANT_REQUEST_REVIEW,
} from '../../contracts/permissions';
import { closedInput, invalid, type ValidationFailure } from '../attributes/attribute-editor';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import type { VariantRequestStore } from '../ports/variant-request.store';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import {
  describeOptions,
  loadProductVariantFacts,
  type DefinitionCache,
  type OptionDescription,
} from '../variant-requests/variant-requests';

export const VARIANT_REQUEST_PAGE_DEFAULT = 25;
export const VARIANT_REQUEST_PAGE_MAX = 100;
export const VARIANT_REQUEST_MAX_PAGE = 1000;
/** One sort, by the time of the request: `asc` (default) puts the one waiting longest first. */
export const VARIANT_REQUEST_SORTS = ['created'] as const;
const MAX_TEXT = 100;

export interface VariantRequestListInput {
  readonly q?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly paging?: unknown;
  /** The older panel's page size; an alias of `pageSize` until the panel pages by number. */
  readonly limit?: unknown;
}

/**
 * What each row action needs (the plan's table, row 4): approve also edits the PLATFORM product,
 * so it needs that key and is offered only when the product lacks the combination; map and decline
 * need the list's own key.
 */
export const VARIANT_REQUEST_ACTION_RULES: readonly RowActionRule<
  Pick<VariantRequestListItem, 'alreadyExists' | 'existing'>
>[] = [
  {
    id: 'approve',
    permission: CATALOG_PLATFORM_PRODUCT_EDIT.key,
    when: (row) => !row.alreadyExists,
  },
  { id: 'map', permission: null, when: (row) => row.existing.length > 0 },
  { id: 'decline', permission: null },
];

export interface VariantRequestListItem {
  readonly id: string;
  /** The version a decision must name. */
  readonly version: number;
  readonly createdAt: string;
  readonly sellerId: string;
  /** The seller's public store name, when it has one. */
  readonly sellerName: string | null;
  readonly offerId: string;
  readonly productId: string;
  readonly productCode: string | null;
  /** What was asked for, named in the Market's default locale. */
  readonly options: readonly OptionDescription[];
  /**
   * The variants the product has now, so the admin can map the request to one. Empty when the
   * product can no longer take a request (retired or paused ones still list: the decision decides).
   */
  readonly existing: readonly {
    readonly variantId: string;
    readonly variantNo: number;
    readonly options: readonly OptionDescription[];
  }[];
  /** True when the product already has the combination: the admin should map, not approve. */
  readonly alreadyExists: boolean;
  /** The row actions of the Actions menu: `approve`, `map`, `decline`, as the caller may run them. */
  readonly actions: readonly string[];
}

export interface VariantRequestListOutput {
  readonly items: readonly VariantRequestListItem[];
  /** Open requests matching the search over all pages; null in `prev-next` mode. */
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: ListPagingMode;
  readonly hasNext: boolean;
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
}

export type VariantRequestListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface VariantRequestListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly variantRequests: VariantRequestStore;
  readonly products: ProductRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly revisions: ProductRevisionRepository;
  readonly attributes: AttributeRepository;
  readonly attributeStore: AttributeDefinitionStore;
  readonly sellerNames: SellerNamesReader;
  readonly policy: CatalogMarketPolicy;
  /** The gate's answer to "does the caller hold `catalog.platform-product.edit`", for `approve`. */
  readonly platformEditProbe: PermissionProbe;
}

/**
 * `variant-request.list` (variants V7; super list phase 2, list 4): the open variant requests of
 * the Market, each with what was asked for, the variants the product has and its row `actions`,
 * for the "Waiting for you" tab. `q` searches the product code; `sort` is `created` with `direction` (`asc`, the default, puts the oldest first); paged by `page` and `pageSize` (1 to 100, default 25) in the mode `paging` names.
 * Rule: the key `catalog.variant-request.review` and the admin population. One read-only unit.
 */
export class VariantRequestList extends UseCase<
  VariantRequestListInput,
  VariantRequestListOutput,
  VariantRequestListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.variant-request-list',
    rule: { kind: 'permissions', allOf: [CATALOG_VARIANT_REQUEST_REVIEW.key] },
  };

  readonly #logger = new Logger('VariantRequestList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: VariantRequestListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: VariantRequestListInput,
  ): Promise<Result<VariantRequestListOutput, VariantRequestListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.variant-request-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: VariantRequestListInput,
  ): Promise<Result<VariantRequestListOutput, VariantRequestListFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input ?? {}, [
      'q',
      'sort',
      'direction',
      'page',
      'pageSize',
      'paging',
      'limit',
    ]);
    if (!body.ok) return body;
    let text: string | null = null;
    const rawText = body.value['q'];
    if (rawText !== undefined && rawText !== null && rawText !== '') {
      if (typeof rawText !== 'string') return invalid('q', 'type');
      const trimmed = rawText.trim();
      if ([...trimmed].length > MAX_TEXT) return invalid('q', 'length');
      if (/\p{Cc}/u.test(trimmed)) return invalid('q', 'format');
      text = trimmed === '' ? null : trimmed;
    }
    const { limit: legacyLimit, ...rest } = body.value;
    const absent = (value: unknown) => value === undefined || value === null || value === '';
    if (!absent(legacyLimit)) {
      if (!absent(rest['pageSize'])) return invalid('limit', 'conflict');
      if (
        typeof legacyLimit !== 'number' ||
        !Number.isInteger(legacyLimit) ||
        legacyLimit < 1 ||
        legacyLimit > VARIANT_REQUEST_PAGE_MAX
      ) {
        return invalid('limit', 'range');
      }
    }
    const paged = parseListQuery(absent(legacyLimit) ? rest : { ...rest, pageSize: legacyLimit }, {
      sorts: VARIANT_REQUEST_SORTS,
      defaultSort: 'created',
      defaultDirection: () => 'asc',
      defaultPageSize: VARIANT_REQUEST_PAGE_DEFAULT,
      maxPageSize: VARIANT_REQUEST_PAGE_MAX,
      maxPage: VARIANT_REQUEST_MAX_PAGE,
    });
    if (!paged.ok) return paged;
    const direction = paged.value.direction;
    const window = pageWindow(paged.value);
    const { market } = context;
    let locales: { default: string; supported: readonly string[] };
    try {
      const configured = this.deps.policy.locales(market);
      locales = { default: configured.default, supported: [...configured.supported] };
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const filter = { productCode: text };
        const total =
          paged.value.paging === 'pages'
            ? await this.deps.variantRequests.countOpen(market, filter)
            : null;
        const open =
          total !== null && window.offset >= total
            ? []
            : await this.deps.variantRequests.pageOpen(market, {
                ...filter,
                direction,
                offset: window.offset,
                limit: window.limit,
              });
        const cache: DefinitionCache = new Map();
        const items: Omit<VariantRequestListItem, 'sellerName' | 'actions'>[] = [];
        // The extra row of the prev-next read only tells there is a next page; it is not described.
        for (const request of open.slice(0, paged.value.pageSize)) {
          const { state } = request;
          const facts = await loadProductVariantFacts(this.deps, market, state.productId);
          const product = await this.deps.products.findById(market, state.productId);
          const existing = [];
          if (facts.ok) {
            for (const variant of facts.value.live) {
              existing.push({
                variantId: variant.variantId,
                variantNo: variant.variantNo,
                options: await describeOptions(
                  this.deps,
                  market,
                  locales.default,
                  variant.optionValues ?? {},
                  cache,
                ),
              });
            }
          }
          items.push({
            id: state.id,
            version: state.version,
            createdAt: state.createdAt.toString(),
            sellerId: state.sellerId,
            offerId: state.offerId,
            productId: state.productId,
            productCode: product === null ? null : product.state.productCode,
            options: await describeOptions(
              this.deps,
              market,
              locales.default,
              state.optionValues,
              cache,
            ),
            existing,
            alreadyExists: facts.ok && facts.value.liveKeys.has(state.optionKey),
          });
        }
        return ok({ items, total, hasNextRow: open.length > paged.value.pageSize });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { items, total, hasNextRow } = read.value;
    let names: ReadonlyMap<Id<'Seller'>, string> = new Map();
    try {
      names = await this.deps.sellerNames.storeNames(context, [
        ...new Set(items.map((item) => item.sellerId as Id<'Seller'>)),
      ]);
    } catch {
      // The queue shows the row without a name, never a guess.
    }
    const granted = await heldKeys(context, {
      [CATALOG_PLATFORM_PRODUCT_EDIT.key]: this.deps.platformEditProbe,
    });
    const page = listPage(
      items.map((item) => ({
        ...item,
        sellerName: names.get(item.sellerId as Id<'Seller'>) ?? null,
        actions: rowActions(item, VARIANT_REQUEST_ACTION_RULES, granted),
      })),
      paged.value,
      total,
    );
    return ok({
      items: page.items,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      paging: page.paging,
      hasNext: paged.value.paging === 'pages' ? page.hasNext : hasNextRow,
      locales,
    });
  }
}
