import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_VARIANT_REQUEST_REVIEW } from '../../contracts/permissions';
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

export const VARIANT_REQUEST_PAGE_DEFAULT = 50;
export const VARIANT_REQUEST_PAGE_MAX = 100;

export interface VariantRequestListInput {
  readonly limit?: unknown;
}

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
}

export interface VariantRequestListOutput {
  readonly items: readonly VariantRequestListItem[];
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
}

/**
 * `variant-request.list` (variants V7): the open variant requests of the Market, oldest first,
 * each with what was asked for and the variants the product has, for the "Waiting for you" tab.
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
    const body = closedInput(input ?? {}, ['limit']);
    if (!body.ok) return body;
    let limit = VARIANT_REQUEST_PAGE_DEFAULT;
    const rawLimit = body.value['limit'];
    if (rawLimit !== undefined && rawLimit !== null) {
      if (
        typeof rawLimit !== 'number' ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > VARIANT_REQUEST_PAGE_MAX
      ) {
        return invalid('limit', 'range');
      }
      limit = rawLimit;
    }
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
        const open = await this.deps.variantRequests.listOpen(market, limit);
        const cache: DefinitionCache = new Map();
        const items: Omit<VariantRequestListItem, 'sellerName'>[] = [];
        for (const request of open) {
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
        return ok(items);
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    let names: ReadonlyMap<Id<'Seller'>, string> = new Map();
    try {
      names = await this.deps.sellerNames.storeNames(context, [
        ...new Set(read.value.map((item) => item.sellerId as Id<'Seller'>)),
      ]);
    } catch {
      // The queue shows the row without a name, never a guess.
    }
    return ok({
      items: read.value.map((item) => ({
        ...item,
        sellerName: names.get(item.sellerId as Id<'Seller'>) ?? null,
      })),
      locales,
    });
  }
}
