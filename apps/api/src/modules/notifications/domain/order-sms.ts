// The text message for "Shipped" (Phase 6 package 4). One short plain-text message: the order
// reference, the carrier, the tracking number when there is one, and the sign-in link. Carrier and
// tracking number are seller-entered, so they are flattened to one line like in the mail.

import { plainLine } from './order-mail';
import { renderTemplate } from './message-templates';

/** A very long message is split and billed in parts; carrier and tracking are already cut short. */
export const SMS_MAX_LENGTH = 320;

export function orderShippedSms(input: {
  readonly orderId: string;
  readonly carrier: string;
  readonly trackingRef: string | null;
  readonly orderUrl: string;
  readonly locale?: string;
}): string {
  return renderTemplate('order-shipped-sms', input.locale ?? 'en', {
    orderId: input.orderId,
    carrier: plainLine(input.carrier),
    tracking: input.trackingRef === null ? '' : ` Tracking number ${plainLine(input.trackingRef)}.`,
    orderUrl: input.orderUrl,
  }).text;
}
