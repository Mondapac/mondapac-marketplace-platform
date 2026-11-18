import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { FlashSales } from '../application/ports/flash-sales';
import type { RedemptionRepository } from '../application/ports/redemption.repository';

/**
 * The units sold of each flash sale: the units of its redemptions that hold (RESERVED or
 * CONFIRMED; a released order gives its units back). Read in a read-only unit of its own. A read
 * that fails is unknown (null), and the quote leaves the flash sales out of a real order.
 */
export class RedemptionFlashSales implements FlashSales {
  constructor(
    private readonly units: UnitOfWork,
    private readonly redemptions: RedemptionRepository,
  ) {}

  async soldUnits(
    context: CallContext,
    promotionIds: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, number> | null> {
    try {
      const read = await this.units.run(
        context.market,
        async () => ok(await this.redemptions.unitsSold(context.market, promotionIds)),
        { readOnly: true },
      );
      return read.ok ? read.value : null;
    } catch {
      return null;
    }
  }
}
