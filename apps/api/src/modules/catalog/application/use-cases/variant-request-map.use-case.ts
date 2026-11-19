import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_VARIANT_REQUEST_REVIEW } from '../../contracts/permissions';
import { VariantRequestDecidedAudit } from '../../domain/audit';
import { closedInput, invalid, type ValidationFailure } from '../attributes/attribute-editor';
import type { ProductRepository } from '../ports/product.repository';
import {
  decisionViewOf,
  requestIdOf,
  requestVersionOf,
  type VariantRequestDecisionView,
} from '../variant-requests/variant-requests';
import {
  deciderOf,
  loadOpenRequest,
  type VariantRequestDecideDependencies,
  type VariantRequestDecisionFailure,
} from '../variant-requests/variant-request-decide';

export interface VariantRequestMapInput {
  readonly [key: string]: unknown;
}

export type VariantRequestMapFailure =
  | VariantRequestDecisionFailure
  | { readonly code: 'access.denied' }
  /** The variant is not a live variant of the request's product. */
  | { readonly code: 'variant-request.variant-unknown' }
  | ValidationFailure;

export interface VariantRequestMapDependencies extends VariantRequestDecideDependencies {
  readonly products: ProductRepository;
}

/**
 * `variant-request.map` (variants V7): an admin points a request at a variant the product already
 * has. The variant must be one of the request's product that is not retired. Rule: the key
 * `catalog.variant-request.review`, the admin population, no acting-as session; the request names
 * the version the admin saw. The product is not changed. One audit row; the seller is told by one
 * mail afterwards.
 */
export class VariantRequestMap extends UseCase<
  VariantRequestMapInput,
  { readonly request: VariantRequestDecisionView },
  VariantRequestMapFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.variant-request-map',
    rule: { kind: 'permissions', allOf: [CATALOG_VARIANT_REQUEST_REVIEW.key] },
  };

  readonly #logger = new Logger('VariantRequestMap');

  constructor(
    gate: UseCaseGate,
    private readonly deps: VariantRequestMapDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: VariantRequestMapInput,
  ): Promise<Result<{ readonly request: VariantRequestDecisionView }, VariantRequestMapFailure>> {
    const result = await this.#map(context, input);
    this.#logger.log({
      msg: 'catalog.variant-request-map',
      code: result.ok ? 'mapped' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #map(
    context: CallContext,
    input: VariantRequestMapInput,
  ): Promise<Result<{ readonly request: VariantRequestDecisionView }, VariantRequestMapFailure>> {
    const accountId = deciderOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['requestId', 'version', 'variantId']);
    if (!body.ok) return body;
    const id = requestIdOf(body.value['requestId']);
    if (id === null) return err({ code: 'variant-request.not-found' });
    const version = requestVersionOf(body.value['version']);
    if (!version.ok) return version;
    const variantId =
      typeof body.value['variantId'] === 'string'
        ? parseId<'Variant'>(body.value['variantId'])
        : null;
    if (variantId === null || !variantId.ok) return invalid('variantId', 'format');
    const { market } = context;
    try {
      return await this.deps.unitOfWork.run<
        { readonly request: VariantRequestDecisionView },
        VariantRequestMapFailure
      >(market, async () => {
        const loaded = await loadOpenRequest(this.deps, market, id, version.value);
        if (!loaded.ok) return err(loaded.error);
        const product = await this.deps.products.findById(market, loaded.value.state.productId);
        if (
          product === null ||
          !product.liveVariants.some((variant) => variant.id === variantId.value)
        ) {
          return err({ code: 'variant-request.variant-unknown' } as const);
        }
        const decided = loaded.value.map({
          accountId,
          variantId: variantId.value,
          now: this.deps.clock.now(),
        });
        if (!decided.ok) return err(decided.error);
        await this.deps.variantRequests.saveDecision(market, decided.value);
        await this.deps.audit.record(
          context,
          VariantRequestDecidedAudit.entry(decided.value.state.id, {
            before: { status: 'open' },
            after: {
              status: 'mapped',
              productId: decided.value.state.productId,
              sellerId: decided.value.state.sellerId,
            },
          }),
        );
        return ok({ request: decisionViewOf(decided.value) });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'variant-request.stale' });
      throw error;
    }
  }
}
