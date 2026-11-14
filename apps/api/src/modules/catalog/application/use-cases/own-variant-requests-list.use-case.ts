import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import {
  MAX_OPEN_VARIANT_REQUESTS_PER_SELLER,
  type VariantRequestStatus,
} from '../../domain/variant-request';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  invalid,
  isoOf,
  sellerOf,
  type ValidationFailure,
} from '../own-reads/own-reads.shared';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { VariantRequestStore } from '../ports/variant-request.store';
import {
  describeOptions,
  type OptionDescription,
  type DefinitionCache,
} from '../variant-requests/variant-requests';

const STATUSES: readonly VariantRequestStatus[] = ['open', 'approved', 'mapped', 'declined'];

export interface OwnVariantRequestsListInput {
  readonly status?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

export interface OwnVariantRequestView {
  readonly id: string;
  readonly offerId: string;
  readonly productId: string;
  readonly productCode: string | null;
  readonly status: VariantRequestStatus;
  /** What was asked for, named in the Market's default locale. */
  readonly options: readonly OptionDescription[];
  /** The variant created (approved) or matched (mapped). */
  readonly resolvedVariantId: string | null;
  /** The reviewer's words (declined). */
  readonly declineReason: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface OwnVariantRequestsListOutput {
  readonly items: readonly OwnVariantRequestView[];
  readonly nextAfterId: string | null;
  /** The seller's waiting requests, whatever the filter, and the most they may have. */
  readonly openCount: number;
  readonly maxOpen: number;
}

export type OwnVariantRequestsListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface OwnVariantRequestsListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly variantRequests: VariantRequestStore;
  readonly products: ProductRepository;
  readonly attributes: AttributeRepository;
  readonly attributeStore: AttributeDefinitionStore;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `own-variant-requests.list` (variants V7): the seller's own variant requests in every status,
 * newest first, keyset-paged, each with what was asked for and its outcome (the variant created or
 * matched, or the reviewer's reason). Rule: the key `catalog.own-product.view` and the seller
 * population; the seller comes from the actor and the store filters by it, so another seller's
 * request is never read. One read-only unit (ADR-0025). The admin's identity is never shown.
 */
export class OwnVariantRequestsList extends UseCase<
  OwnVariantRequestsListInput,
  OwnVariantRequestsListOutput,
  OwnVariantRequestsListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-variant-requests-list',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('OwnVariantRequestsList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnVariantRequestsListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnVariantRequestsListInput,
  ): Promise<Result<OwnVariantRequestsListOutput, OwnVariantRequestsListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.own-variant-requests-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: OwnVariantRequestsListInput,
  ): Promise<Result<OwnVariantRequestsListOutput, OwnVariantRequestsListFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    for (const key of Object.keys(input)) {
      if (key !== 'status' && key !== 'afterId' && key !== 'limit') return invalid(key, 'unknown');
    }
    let status: VariantRequestStatus | null = null;
    if (input.status !== undefined && input.status !== null) {
      if (typeof input.status !== 'string' || !STATUSES.includes(input.status as never)) {
        return invalid('status', 'enum');
      }
      status = input.status as VariantRequestStatus;
    }
    let afterId: Id<'VariantRequest'> | null = null;
    if (input.afterId !== undefined && input.afterId !== null) {
      const parsed =
        typeof input.afterId === 'string' ? parseId<'VariantRequest'>(input.afterId) : null;
      if (parsed === null || !parsed.ok) return invalid('afterId', 'format');
      afterId = parsed.value;
    }
    let limit = DEFAULT_PAGE_SIZE;
    if (input.limit !== undefined && input.limit !== null) {
      if (
        typeof input.limit !== 'number' ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_PAGE_SIZE
      ) {
        return invalid('limit', 'range');
      }
      limit = input.limit;
    }
    const { market } = context;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const { variantRequests: requests, products } = this.deps;
        // One extra row tells whether another page follows.
        const rows = await requests.listOfSeller(market, sellerId, {
          status,
          afterId,
          limit: limit + 1,
        });
        const shown = rows.slice(0, limit);
        const cache: DefinitionCache = new Map();
        const items: OwnVariantRequestView[] = [];
        for (const request of shown) {
          const { state } = request;
          const product = await products.findById(market, state.productId);
          items.push({
            id: state.id,
            offerId: state.offerId,
            productId: state.productId,
            productCode: product === null ? null : product.state.productCode,
            status: state.status,
            options: await describeOptions(this.deps, market, locale, state.optionValues, cache),
            resolvedVariantId: state.resolvedVariantId,
            declineReason: state.declineReason,
            createdAt: state.createdAt.toString(),
            decidedAt: isoOf(state.decidedAt),
          });
        }
        return ok({
          items,
          nextAfterId: rows.length > limit ? (shown[shown.length - 1]?.state.id ?? null) : null,
          openCount: await requests.openCountOfSeller(market, sellerId),
          maxOpen: MAX_OPEN_VARIANT_REQUESTS_PER_SELLER,
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok(read.value);
  }
}
