import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PRICING_PRICE_HOLD_DECIDE } from '../../contracts/permissions';
import { PriceHoldApproved } from '../../domain/audit';
import type { RegularPriceRecord } from '../../domain/price-series';
import {
  decideHold,
  type HoldDecisionDependencies,
  type HoldDecisionFailure,
} from '../hold-decision';
import { parseRecordId } from '../hold-review';
import type { PricingPolicyProvider } from '../ports/pricing-policy-provider';

export interface ApprovePriceHoldInput {
  /** The record the screen showed (design 3.1 row 3). */
  readonly recordId: string;
}

export interface ApprovePriceHoldOutput {
  readonly recordId: Id<'RegularPriceRecord'>;
  readonly outcome: 'approved';
  /** The instant the approved price takes effect: from approval, never from submission. */
  readonly effectiveFrom: Temporal.Instant;
  readonly seriesVersion: number;
}

export interface ApprovePriceHoldDependencies extends HoldDecisionDependencies {
  readonly policies: PricingPolicyProvider;
}

/**
 * `pricing.approve-price-hold` (pricing design 3.1 row 3, 5.2, 8, 9). Rule
 * `permissions [pricing.price-hold.decide]` (protected, platform scope). The decider is an admin
 * account and never the account that submitted the record (H4, re-checked in the aggregate and
 * by the table's `decider_check`); the amount is checked again against the **current** policy;
 * the record becomes effective from the approval. The Q2 guard against a running special joins
 * with the special stream (slice 5). Events carry no amount; the audit row carries the amount
 * through the `money` kind.
 */
export class ApprovePriceHold extends UseCase<
  ApprovePriceHoldInput,
  ApprovePriceHoldOutput,
  HoldDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.approve-price-hold',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_HOLD_DECIDE.key] },
  };

  readonly #logger = new Logger('ApprovePriceHold');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ApprovePriceHoldDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ApprovePriceHoldInput,
  ): Promise<Result<ApprovePriceHoldOutput, HoldDecisionFailure>> {
    const { actor, market } = context;
    // The decide key is admin scope; checked again here, where the decider's account is needed.
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const recordId = parseRecordId(input?.recordId);
    if (recordId === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'recordId', code: 'format' }] });
    }

    const decided = await decideHold(
      this.deps,
      context,
      recordId,
      (series, now) => {
        const policy = this.deps.policies.forOffer(market, series.state.offerId);
        const approved = series.approveHold({ recordId, decidedBy: actor.accountId, now, policy });
        if (!approved.ok) {
          if (approved.error.code === 'pricing.policy-market-mismatch') {
            throw new Error('pricing.approve-price-hold: the policy is of another Market');
          }
          return err(approved.error);
        }
        return ok(approved.value);
      },
      async (series, record: RegularPriceRecord) => {
        const { id, offerId, variantId } = series.state;
        if (record.anchor === null || record.effectiveFrom === null) {
          throw new Error('pricing.approve-price-hold: an approved record without its anchor');
        }
        await this.deps.audit.record(
          context,
          PriceHoldApproved.entry(id, {
            after: {
              offerId,
              variantId,
              recordId: record.id,
              amount: record.amount,
              anchorRecordId: record.anchor.recordId,
              anchorAmount: record.anchor.amount,
              effectiveFrom: record.effectiveFrom,
            },
          }),
        );
      },
    );
    this.#logger.log({
      msg: 'pricing.approve-price-hold',
      outcome: decided.ok ? 'approved' : decided.error.code,
      recordId,
      accountId: actor.accountId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    if (!decided.ok) return decided;
    const record = decided.value.decided;
    if (record.effectiveFrom === null) throw new Error('an approved record has no effective start');
    return ok({
      recordId,
      outcome: 'approved',
      effectiveFrom: record.effectiveFrom,
      seriesVersion: decided.value.series.state.version,
    });
  }
}
