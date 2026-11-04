import type { SellerHealthPolicy } from '../application/ports/seller-health-policy';
import type { SellerHealthSettings } from '../domain/seller-health';
import type { SellerHealthWindows } from '../domain/seller-health-days';

/**
 * The thresholds of the approved design (seller health plan), in hundredths of a percent for the
 * rates and in hundredths of a star for the rating. The points where a metric scores zero are
 * the product owner's to confirm. This is the same for every Market until the editable
 * Market settings (ADM-06, Settings › Seller health) replace it, which is why it is a policy
 * port behind one class and not a constant in the use cases.
 */
export const DEFAULT_SELLER_HEALTH_SETTINGS: SellerHealthSettings = {
  minOrders: 10,
  minReviews: 5,
  sellerCancellations: { healthyBelow: 250, atRiskUpTo: 500, zeroAt: 1000 },
  lateReady: { healthyBelow: 400, atRiskUpTo: 1000, zeroAt: 2000 },
  lostDisputes: { healthyBelow: 50, atRiskUpTo: 100, zeroAt: 200 },
  customerRating: { healthyFrom: 400, atRiskFrom: 350, best: 500, zeroAt: 100 },
  reports: { healthyBelow: 1, atRiskUpTo: 2, zeroAt: 5 },
};

export const DEFAULT_SELLER_HEALTH_WINDOWS: SellerHealthWindows = { shortDays: 30, longDays: 90 };

export class DefaultSellerHealthPolicy implements SellerHealthPolicy {
  settings() {
    return Promise.resolve({
      thresholds: DEFAULT_SELLER_HEALTH_SETTINGS,
      windows: DEFAULT_SELLER_HEALTH_WINDOWS,
    });
  }
}
