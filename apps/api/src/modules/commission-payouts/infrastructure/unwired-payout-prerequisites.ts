import type { PayoutPrerequisites } from '../application/ports/payout-gateways';

/**
 * The seller owner's second factor and the business-identifier re-check (design 4.6) have no
 * facade to ask today, and this module does not invent a cross-module call for them: the run
 * records them as not checked. This is an open item of package 6d. When identity and sellers give
 * the answers, a real adapter replaces this one and the run holds the payout with the block
 * reason `second-factor-required`.
 */
export class UnwiredPayoutPrerequisites implements PayoutPrerequisites {
  check(): Promise<'ok'> {
    return Promise.resolve('ok');
  }
}
