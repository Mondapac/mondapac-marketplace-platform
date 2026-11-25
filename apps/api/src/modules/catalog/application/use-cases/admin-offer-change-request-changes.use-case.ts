import { Logger } from '@nestjs/common';
import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import {
  decideHeldChange,
  type OfferChangeDecided,
  type OfferChangeDecisionDependencies,
  type OfferChangeDecisionFailure,
} from '../offer-change-decision';
import { parseChangeDecision } from '../offer-change-view';

export interface AdminOfferChangeRequestChangesInput {
  readonly changeId: string;
  /** The reviewer's note to the seller: 1 to 2000 characters. Never logged. */
  readonly note: unknown;
}

/**
 * `admin-offer-change.request-changes` (risk-based Offer approval, slice 2c; ADR-0051): a reviewer
 * sends a held change of a live Offer back to the seller with a note (required, 1 to 2000 characters). The live Offer stays as it is; the seller's next edit is judged again. Rule: the key `catalog.product.approve` and the admin population, as the Offer
 * review decisions. An unknown change is `offer-change.not-found`; one decided already is
 * `offer-change.not-pending`; a lost race is `conflict.stale`. One unit, Offer row first.
 */
export class AdminOfferChangeRequestChanges extends UseCase<
  AdminOfferChangeRequestChangesInput,
  OfferChangeDecided,
  OfferChangeDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-offer-change-request-changes',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  };

  readonly #logger = new Logger('AdminOfferChangeRequestChanges');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferChangeDecisionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminOfferChangeRequestChangesInput,
  ): Promise<Result<OfferChangeDecided, OfferChangeDecisionFailure>> {
    const result = await this.#decide(context, input);
    this.#logger.log({
      msg: 'catalog.admin-offer-change-request-changes',
      code: result.ok ? result.value.status : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #decide(
    context: CallContext,
    input: AdminOfferChangeRequestChangesInput,
  ): Promise<Result<OfferChangeDecided, OfferChangeDecisionFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const parsed = parseChangeDecision(input, 'required');
    if (!parsed.ok) return parsed;
    const note = parsed.value.note;
    if (note === null)
      return err({ code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] });
    return decideHeldChange(
      this.deps,
      context,
      { changeId: parsed.value.changeId },
      { kind: 'request-changes', note },
    );
  }
}
