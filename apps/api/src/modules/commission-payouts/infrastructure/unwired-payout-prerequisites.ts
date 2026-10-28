import { Logger } from '@nestjs/common';
import type { PayoutPrerequisites } from '../application/ports/payout-gateways';

/**
 * The seller owner's second factor and the business-identifier re-check (design 4.6) have no
 * facade to ask today, and this module does not invent a cross-module call for them. In test mode
 * the run records them as not checked and goes on (an open item of package 6d). Where payments
 * runs against the live provider this adapter fails closed: it answers `unavailable`, so the run
 * decides nothing and no money moves until a real adapter replaces it. When identity and sellers
 * give the answers, that adapter replaces this one and the run holds the payout with the block
 * reason `second-factor-required`.
 */
export class UnwiredPayoutPrerequisites implements PayoutPrerequisites {
  constructor(private readonly providerLive: boolean) {
    if (providerLive) {
      new Logger('CommissionPayoutsPrerequisites').warn(
        'payments runs against the live provider while the payout prerequisites are unwired: the payout run is closed',
      );
    }
  }

  check(): Promise<'ok' | 'unavailable'> {
    return Promise.resolve(this.providerLive ? 'unavailable' : 'ok');
  }
}

/**
 * Whether the Stripe secret key is not a test-mode key. A missing key is not live. The boot
 * config refuses a live key today; this keeps the payout run closed if that ever changes first.
 */
export const isLiveStripeKey = (key: string | null): boolean =>
  key !== null && !/^(sk|rk)_test_/.test(key);
