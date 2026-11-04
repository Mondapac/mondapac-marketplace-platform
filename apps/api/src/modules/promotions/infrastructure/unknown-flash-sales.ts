import type { FlashSales } from '../application/ports/flash-sales';

/**
 * No units-sold counter exists yet (package T2 keeps it with the reservations), so the count of
 * every flash sale is unknown. The quote then leaves a flash sale out of a real order (fail
 * closed) and counts it as sold 0 in a test order only.
 */
export class UnknownFlashSales implements FlashSales {
  soldUnits(): Promise<null> {
    return Promise.resolve(null);
  }
}
