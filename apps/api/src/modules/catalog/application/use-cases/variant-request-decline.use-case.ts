import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_VARIANT_REQUEST_REVIEW } from '../../contracts/permissions';
import { VariantRequestDecidedAudit } from '../../domain/audit';
import { closedInput, invalid, type ValidationFailure } from '../attributes/attribute-editor';
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

export interface VariantRequestDeclineInput {
  readonly [key: string]: unknown;
}

export type VariantRequestDeclineFailure =
  VariantRequestDecisionFailure | { readonly code: 'access.denied' } | ValidationFailure;

/**
 * `variant-request.decline` (variants V7): an admin closes a request with a reason the seller
 * reads. Rule: the key `catalog.variant-request.review`, the admin population, no acting-as
 * session; the request names the version the admin saw. The reason is kept on the request and
 * never in the audit row. One audit row; the seller is told by one mail afterwards.
 */
export class VariantRequestDecline extends UseCase<
  VariantRequestDeclineInput,
  { readonly request: VariantRequestDecisionView },
  VariantRequestDeclineFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.variant-request-decline',
    rule: { kind: 'permissions', allOf: [CATALOG_VARIANT_REQUEST_REVIEW.key] },
  };

  readonly #logger = new Logger('VariantRequestDecline');

  constructor(
    gate: UseCaseGate,
    private readonly deps: VariantRequestDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: VariantRequestDeclineInput,
  ): Promise<
    Result<{ readonly request: VariantRequestDecisionView }, VariantRequestDeclineFailure>
  > {
    const result = await this.#decline(context, input);
    this.#logger.log({
      msg: 'catalog.variant-request-decline',
      code: result.ok ? 'declined' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #decline(
    context: CallContext,
    input: VariantRequestDeclineInput,
  ): Promise<
    Result<{ readonly request: VariantRequestDecisionView }, VariantRequestDeclineFailure>
  > {
    const accountId = deciderOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['requestId', 'version', 'reason']);
    if (!body.ok) return body;
    const id = requestIdOf(body.value['requestId']);
    if (id === null) return err({ code: 'variant-request.not-found' });
    const version = requestVersionOf(body.value['version']);
    if (!version.ok) return version;
    const reason = body.value['reason'];
    if (typeof reason !== 'string' || [...reason].length > 1000) return invalid('reason', 'type');
    const { market } = context;
    try {
      return await this.deps.unitOfWork.run<
        { readonly request: VariantRequestDecisionView },
        VariantRequestDeclineFailure
      >(market, async () => {
        const loaded = await loadOpenRequest(this.deps, market, id, version.value);
        if (!loaded.ok) return err(loaded.error);
        const decided = loaded.value.decline({ accountId, reason, now: this.deps.clock.now() });
        if (!decided.ok) return err(decided.error);
        await this.deps.variantRequests.saveDecision(market, decided.value);
        await this.deps.audit.record(
          context,
          VariantRequestDecidedAudit.entry(decided.value.state.id, {
            before: { status: 'open' },
            after: {
              status: 'declined',
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
