import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PRICING_PRICE_HOLD_DECIDE } from '../../contracts/permissions';
import { PriceHoldApproved, SpecialPriceWithdrawn } from '../../domain/audit';
import { specialChanges, type RegularPriceRecord } from '../../domain/price-series';
import { holdReference, type SpecialPriceRecord } from '../../domain/special-price';
import {
  decideHold,
  type HoldDecisionDependencies,
  type HoldDecisionFailure,
} from '../hold-decision';
import { asSpecialId, parseRecordId } from '../hold-review';
import type { PricingPolicyProvider } from '../ports/pricing-policy-provider';

export interface ApprovePriceHoldInput {
  /** The record the screen showed (design 3.1 row 3); a regular or a special record. */
  readonly recordId: string;
}

export interface ApprovePriceHoldOutput {
  readonly recordId: Id<'RegularPriceRecord'> | Id<'SpecialPriceRecord'>;
  readonly outcome: 'approved';
  /** The instant the approved price takes effect: from approval, never from submission. */
  readonly effectiveFrom: Temporal.Instant;
  readonly seriesVersion: number;
}

export interface ApprovePriceHoldDependencies extends HoldDecisionDependencies {
  readonly policies: PricingPolicyProvider;
}

/** What the decision approved, and for a special the special it replaced. */
type Approved =
  | { readonly kind: 'regular'; readonly record: RegularPriceRecord }
  | {
      readonly kind: 'special';
      readonly record: SpecialPriceRecord;
      readonly withdrawn: readonly SpecialPriceRecord[];
    };

/**
 * `pricing.approve-price-hold` (pricing design 3.1 row 3, 5.2, 8, 9). Rule
 * `permissions [pricing.price-hold.decide]` (protected, platform scope). The decider is an admin
 * account and never the account that submitted the record (H4, re-checked in the aggregate and
 * by the table's `decider_check`); the amount is checked again against the **current** policy;
 * the record becomes effective from the approval. A regular price at or below a running or
 * scheduled special is refused (Q2); a special must still be strictly below the current regular
 * price and its window must not have ended. An approved special withdraws the one it replaces.
 * Events carry no amount; the audit row carries the amount through the `money` kind.
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
      (series, now): Result<Approved, HoldDecisionFailure> => {
        const policy = this.deps.policies.forOffer(market, series.state.offerId);
        if (series.hasSpecial(recordId)) {
          const approved = series.approveSpecialHold({
            recordId: asSpecialId(recordId),
            decidedBy: actor.accountId,
            now,
            policy,
          });
          if (!approved.ok) {
            if (approved.error.code === 'pricing.policy-market-mismatch') {
              throw new Error('pricing.approve-price-hold: the policy is of another Market');
            }
            return err(approved.error);
          }
          // Read before the save: the special this approval replaced.
          const { withdrawn } = specialChanges(series);
          return ok({ kind: 'special', record: approved.value, withdrawn });
        }
        const approved = series.approveHold({ recordId, decidedBy: actor.accountId, now, policy });
        if (!approved.ok) {
          if (approved.error.code === 'pricing.policy-market-mismatch') {
            throw new Error('pricing.approve-price-hold: the policy is of another Market');
          }
          return err(approved.error);
        }
        return ok({ kind: 'regular', record: approved.value });
      },
      async (series, approved: Approved) => {
        const { id, offerId, variantId } = series.state;
        if (approved.kind === 'special') {
          const { record } = approved;
          if (record.effectiveFrom === null) {
            throw new Error('pricing.approve-price-hold: an approved special without its start');
          }
          const reference = holdReference(record);
          await this.deps.audit.record(
            context,
            PriceHoldApproved.entry(id, {
              after: {
                offerId,
                variantId,
                recordId: record.id,
                amount: record.amount,
                anchorRecordId: reference.recordId,
                anchorAmount: reference.amount,
                effectiveFrom: record.effectiveFrom,
              },
            }),
          );
          for (const ended of approved.withdrawn) {
            await this.deps.audit.record(
              context,
              SpecialPriceWithdrawn.entry(id, {
                after: { offerId, variantId, recordId: ended.id, cause: 'replaced' },
              }),
            );
          }
          return;
        }
        const { record } = approved;
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
    const record = decided.value.decided.record;
    if (record.effectiveFrom === null) throw new Error('an approved record has no effective start');
    return ok({
      recordId,
      outcome: 'approved',
      effectiveFrom: record.effectiveFrom,
      seriesVersion: decided.value.series.state.version,
    });
  }
}
