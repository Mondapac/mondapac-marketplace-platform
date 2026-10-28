import type { FlashSales } from '../application/ports/flash-sales';
import type { SellerActivity } from '../application/ports/seller-activity';
import type { PriceHistory } from '../application/ports/price-history';

/**
 * `sellers` publishes no "active since" read yet, so every seller's age is unknown and the
 * approval rule treats it as new: a seller promotion waits for approval (fail closed). A later
 * package binds the sellers facade here instead.
 */
export class UnknownSellerActivity implements SellerActivity {
  activeSince(): Promise<null> {
    return Promise.resolve(null);
  }
}

/**
 * `pricing` publishes no price-history read yet, so the days a product sold at a price are
 * unknown and the was-price rule answers "not eligible" (fail closed). A later package binds the
 * pricing facade here instead.
 */
export class UnknownPriceHistory implements PriceHistory {
  daysSoldAtPrice(): Promise<null> {
    return Promise.resolve(null);
  }
}

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
