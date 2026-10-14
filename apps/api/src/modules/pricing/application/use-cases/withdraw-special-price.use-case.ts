import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PRICING_PRICE_EDIT } from '../../contracts/permissions';
import { SpecialPriceSuperseded, SpecialPriceWithdrawn } from '../../domain/audit';
import type { PriceSeries, WithdrawSpecialPriceOutcome } from '../../domain/price-series';
import {
  sellerSeriesWrite,
  type SellerSeriesWriteDependencies,
  type SellerSeriesWriteFailure,
} from '../seller-series-write';
import { reserveWriteAllowance, type WriteThrottled } from '../write-allowance';

export interface WithdrawSpecialPriceInput {
  readonly offerId: string;
  readonly variantId: string;
  /** The series version the seller's screen showed. */
  readonly expectedVersion: number;
}

export interface WithdrawSpecialPriceOutput {
  /** The series version after the write. */
  readonly seriesVersion: number;
  /** The running or scheduled special that was ended now, or null. */
  readonly endedRecordId: Id<'SpecialPriceRecord'> | null;
  /** The special that waited for review and was cancelled, or null. */
  readonly cancelledRecordId: Id<'SpecialPriceRecord'> | null;
}

export type WithdrawSpecialPriceFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.denied' }
  | SellerSeriesWriteFailure
  | WriteThrottled
  | { readonly code: 'pricing.series-retired' }
  /** Neither a running or scheduled special nor a pending one, or no price series at all. */
  | { readonly code: 'pricing.special-price.not-found' };

export type WithdrawSpecialPriceDependencies = SellerSeriesWriteDependencies;

/**
 * `pricing.withdraw-special-price` (pricing design 3.2, 5.2; slice 5). A seller ends the running
 * or scheduled special of one Variant of an own Offer now, and cancels a special that waits for
 * review. The regular price is the price from that moment. Ownership and the refusal answers
 * are those of `pricing.set-regular-price`.
 */
export class WithdrawSpecialPrice extends UseCase<
  WithdrawSpecialPriceInput,
  WithdrawSpecialPriceOutput,
  WithdrawSpecialPriceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.withdraw-special-price',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('WithdrawSpecialPrice');

  constructor(
    gate: UseCaseGate,
    private readonly deps: WithdrawSpecialPriceDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: WithdrawSpecialPriceInput,
  ): Promise<Result<WithdrawSpecialPriceOutput, WithdrawSpecialPriceFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const fields: { path: string; code: string }[] = [];
    const offerId = parseId<'Offer'>(input?.offerId);
    if (!offerId.ok) fields.push({ path: 'offerId', code: 'format' });
    const variantId = parseId<'Variant'>(input?.variantId);
    if (!variantId.ok) fields.push({ path: 'variantId', code: 'format' });
    const expected: unknown = input?.expectedVersion;
    if (!(typeof expected === 'number' && Number.isSafeInteger(expected) && expected >= 1)) {
      fields.push({ path: 'expectedVersion', code: 'format' });
    }
    if (fields.length > 0 || !offerId.ok || !variantId.ok) {
      return err({ code: 'validation.failed', fields });
    }

    const allowed = await reserveWriteAllowance(this.deps, context, actor.accountId);
    if (!allowed.ok) return allowed;

    const written = await sellerSeriesWrite<
      WithdrawSpecialPriceOutcome,
      WithdrawSpecialPriceFailure
    >(this.deps, context, this.#logger, {
      accountId: actor.accountId,
      sellerId: actor.sellerId,
      offerId: offerId.value,
      variantId: variantId.value,
      expectedVersion: expected as number,
      missingSeries: { code: 'pricing.special-price.not-found' },
      apply: (series, now) => series.withdrawSpecialPrice(now),
      audit: (series, outcome) => this.audit(context, series, outcome),
    });
    this.#logger.log({
      msg: 'pricing.withdraw-special-price',
      outcome: written.ok ? 'withdrawn' : written.error.code,
      offerId: offerId.value,
      accountId: actor.accountId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    if (!written.ok) return written;
    const { value: outcome, series } = written.value;
    return ok({
      seriesVersion: series.state.version,
      endedRecordId: outcome.withdrawn?.id ?? null,
      cancelledRecordId: outcome.cancelled?.id ?? null,
    });
  }

  private async audit(
    context: CallContext,
    series: PriceSeries,
    outcome: WithdrawSpecialPriceOutcome,
  ): Promise<void> {
    const { id, offerId, variantId } = series.state;
    if (outcome.cancelled !== null) {
      await this.deps.audit.record(
        context,
        SpecialPriceSuperseded.entry(id, {
          after: {
            offerId,
            variantId,
            recordId: outcome.cancelled.id,
            cause: 'cancelled',
            supersededByRecordId: null,
          },
        }),
      );
    }
    if (outcome.withdrawn !== null) {
      await this.deps.audit.record(
        context,
        SpecialPriceWithdrawn.entry(id, {
          after: { offerId, variantId, recordId: outcome.withdrawn.id, cause: 'withdrawn' },
        }),
      );
    }
  }
}
