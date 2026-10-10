import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PRICING_PRICE_HOLD_VIEW } from '../../contracts/permissions';
import { parseRecordId } from '../hold-review';
import type { PendingHoldView, PriceSeriesRepository } from '../ports/price-series.repository';

export interface ViewPriceHoldInput {
  readonly recordId: string;
}

export type ViewPriceHoldFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  /** Unknown, another Market's, or no longer pending: one answer (design 5.2). */
  | { readonly code: 'pricing.hold.not-found' };

export interface ViewPriceHoldDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
}

/**
 * `pricing.view-price-hold` (pricing design 5.2): one held record with its anchor. Rule
 * `permissions [pricing.price-hold.view]`. The id is looked up in the context's Market only, so
 * another Market's record answers exactly as an unknown id.
 */
export class ViewPriceHold extends UseCase<
  ViewPriceHoldInput,
  PendingHoldView,
  ViewPriceHoldFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.view-price-hold',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_HOLD_VIEW.key] },
  };

  readonly #logger = new Logger('ViewPriceHold');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewPriceHoldDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewPriceHoldInput,
  ): Promise<Result<PendingHoldView, ViewPriceHoldFailure>> {
    const recordId = parseRecordId(input?.recordId);
    if (recordId === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'recordId', code: 'format' }] });
    }
    const { market } = context;
    const read = await this.deps.unitOfWork.run<PendingHoldView | null, never>(
      market,
      async () => ok(await this.deps.series.findPendingHold(market, recordId)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('pricing.view-price-hold: the read failed');
    this.#logger.log({
      msg: 'pricing.view-price-hold',
      found: read.value !== null,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return read.value === null ? err({ code: 'pricing.hold.not-found' }) : ok(read.value);
  }
}
