import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { SubjectLimitClass } from '../../../platform/rate-limit/rate-limit-counters';
import type { SubjectRateLimits } from '../../../platform/rate-limit/subject-rate-limits';
import type {
  AdminActionLimits,
  AdminActionLimitSettings,
  AdminLimitedAction,
} from '../application/ports/admin-action-limits';

const CLASS_OF: Readonly<Record<AdminLimitedAction, SubjectLimitClass>> = Object.freeze({
  'password-reset': 'admin-customer-password-reset',
  'pii-reveal': 'admin-customer-pii-reveal',
});

/**
 * {@link AdminActionLimits} on the platform's shared counters (classes
 * `admin-customer-password-reset` and `admin-customer-pii-reveal`, one-hour windows) and the
 * Market's `customers.adminActionLimits`.
 */
export class SubjectAdminActionLimits implements AdminActionLimits {
  constructor(
    private readonly counters: SubjectRateLimits,
    private readonly markets: MarketRegistry,
  ) {}

  settings(market: MarketContext): AdminActionLimitSettings | null {
    return this.markets.get(market.marketId).customers?.adminActionLimits ?? null;
  }

  count(action: AdminLimitedAction, subject: string) {
    return this.counters.count(CLASS_OF[action], subject);
  }
}
