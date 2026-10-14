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
import type { PendingHoldView, PriceSeriesRepository } from '../ports/price-series.repository';

export interface ListPriceHoldsInput {
  /** The `next` of the previous page, or null for the first. */
  readonly after: string | null;
  /** 1 to 100; null for the default of 50. */
  readonly limit: number | null;
}

export interface PriceHoldPage {
  readonly items: readonly PendingHoldView[];
  /** The `after` of the next page, or null after the last. */
  readonly next: string | null;
}

export type ListPriceHoldsFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
};

export interface ListPriceHoldsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
}

/**
 * `pricing.list-price-holds` (pricing design 5.2, PD5): the review queue of held regular prices
 * of the context's Market, oldest submission first, paged by keyset. Rule
 * `permissions [pricing.price-hold.view]` (platform scope). One read-only unit (ADR-0025). A row
 * holds ids, the held amount, the anchor amount and the direction: no Cost, no submitter and no
 * seller data beyond the seller's id (brief s5).
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
    const read = await this.deps.unitOfWork.run<readonly PendingHoldView[], never>(
      market,
      async () => ok(await this.deps.series.listPendingHolds(market, cursor, limit + 1)),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('pricing.list-price-holds: the read failed');
    const rows = read.value;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const page: PriceHoldPage = {
      items,
      next:
        rows.length > limit && last !== undefined
          ? encodeHoldCursor({ submittedAt: last.submittedAt, id: last.recordId })
          : null,
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
