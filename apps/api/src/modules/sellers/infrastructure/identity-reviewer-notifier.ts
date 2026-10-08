import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellerAccessContract } from '../../identity/contracts/seller-access.contract';
import type {
  ReviewerNoticeResult,
  ReviewerNotifier,
} from '../application/ports/reviewer-notifier';

/**
 * {@link ReviewerNotifier} on `identity`'s `notifyAccessReviewers` (identity design 8.7; request
 * R-3). The outcome is reduced to three words; no recipient, count or address passes through. A
 * refusal of the gate or of the request throws.
 */
export class IdentityReviewerNotifier implements ReviewerNotifier {
  constructor(private readonly identity: SellerAccessContract) {}

  async notify(context: CallContext, sellerId: Id<'Seller'>): Promise<ReviewerNoticeResult> {
    const result = await this.identity.notifyAccessReviewers(context, sellerId);
    if (result.ok) {
      return result.value.code === 'reviewer-notice.sent' ? 'sent' : 'skipped';
    }
    if (result.error.code === 'reviewer-notice.unavailable') return 'unavailable';
    throw new Error(`identity.notifyAccessReviewers refused: ${result.error.code}`);
  }
}
