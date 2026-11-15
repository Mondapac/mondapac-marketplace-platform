import type { MarketContext } from '@mondapac/shared-kernel';
import type { DeliveryChannel, DeliveryOutcome } from '../../domain/delivery';
import type { RosterMember } from '../../domain/roster';

/**
 * A message to one roster member: a subject line and plain text built by the application from
 * codes, counts and instants only (no address, account id, IP or payload).
 */
export interface AlertMessage {
  readonly subject: string;
  readonly text: string;
}

/**
 * Sends a message on one channel (email through the platform mail transport; SMS, call and team
 * chat through providers not yet chosen, which answer `not-configured`). Never throws: a failed
 * send answers `failed`; a member without the channel's contact answers `no-contact`. Never logs
 * an address, a number or the text.
 */
export interface AlertMessenger {
  send(
    market: MarketContext,
    member: RosterMember,
    channel: DeliveryChannel,
    message: AlertMessage,
  ): Promise<DeliveryOutcome>;
}

export const ALERT_MESSENGER = Symbol('ALERT_MESSENGER');
