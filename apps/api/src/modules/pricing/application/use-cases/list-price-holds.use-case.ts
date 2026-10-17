import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PRICING_PRICE_HOLD_VIEW } from '../../contracts/permissions';
import {
  decodeHoldCursor,
  DEFAULT_HOLD_PAGE,
  encodeHoldCursor,
  MAX_HOLD_PAGE,
} from '../hold-review';
import { withHoldLabels, type HoldLabelDependencies, type LabelledHold } from '../hold-labels';
import type { PendingHoldView, PriceSeriesRepository } from '../ports/price-series.repository';

export interface ListPriceHoldsInput {
  /** The `next` of the previous page, or null for the first. */
  readonly after: string | null;
  /** 1 to 100; null for the default of 50. */
  readonly limit: number | null;
}

export interface PriceHoldPage {
  readonly items: readonly LabelledHold[];
  /** The `after` of the next page, or null after the last. */
  readonly next: string | null;
  /** Every pending record of the Market, whatever the page. */
  readonly total: number;
}

export type ListPriceHoldsFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
};

export interface ListPriceHoldsDependencies extends HoldLabelDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
}

/**
 * `pricing.list-price-holds` (pricing design 5.2, PD5): the review queue of held regular prices
 * of the context's Market, oldest submission first, paged by keyset. Rule
 * `permissions [pricing.price-hold.view]` (platform scope; checked first, the labels are read only
 * after it passes). One read-only unit (ADR-0025). A row holds ids, the held amount, the anchor
 * amount and the direction, plus three display names read after the unit closes: the published
 * product name, the published Variant label (catalog `sellUnitLabels`) and the seller's public
 * store name (sellers `sellerSummaries`), one batched call each; a failed or absent lookup leaves
 * its field null and never fails the queue. No Cost (brief s5 is about Cost only), no submitter,
 * no legal name or address.
 */
export class ListPriceHolds extends UseCase<
  ListPriceHoldsInput,
  PriceHoldPage,
  ListPriceHoldsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.list-price-holds',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_HOLD_VIEW.key] },
  };

  readonly #logger = new Logger('ListPriceHolds');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListPriceHoldsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListPriceHoldsInput,
  ): Promise<Result<PriceHoldPage, ListPriceHoldsFailure>> {
    const fields: { path: string; code: string }[] = [];
    const cursor = input?.after == null ? null : decodeHoldCursor(String(input.after));
    if (input?.after != null && cursor === null) fields.push({ path: 'after', code: 'format' });
    const asked: unknown = input?.limit ?? DEFAULT_HOLD_PAGE;
    if (!(
      typeof asked === 'number' &&
      Number.isSafeInteger(asked) &&
      asked >= 1 &&
      asked <= MAX_HOLD_PAGE
    )) {
      fields.push({ path: 'limit', code: 'range' });
    }
    if (fields.length > 0) return err({ code: 'validation.failed', fields });
    const limit = asked as number;

    const { market } = context;
    const read = await this.deps.unitOfWork.run<
      { readonly rows: readonly PendingHoldView[]; readonly total: number },
      never
    >(
      market,
      async () =>
        ok({
          rows: await this.deps.series.listPendingHolds(market, cursor, limit + 1),
          total: await this.deps.series.countPendingHolds(market),
        }),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('pricing.list-price-holds: the read failed');
    const { rows, total } = read.value;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const labelled = await withHoldLabels(this.deps, context, items);
    const page: PriceHoldPage = {
      items: labelled,
      next:
        rows.length > limit && last !== undefined
          ? encodeHoldCursor({ submittedAt: last.submittedAt, id: last.recordId })
          : null,
      total,
    };
    this.#logger.log({
      msg: 'pricing.list-price-holds',
      rows: items.length,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(page);
  }
}
