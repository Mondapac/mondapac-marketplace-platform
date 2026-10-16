// The text message for "Shipped" (Phase 6 package 4). One short plain-text message: the order
// reference, the carrier, the tracking number when there is one, and the sign-in link. Carrier and
// tracking number are seller-entered, so they are flattened to one line like in the mail.

import { plainLine } from './order-mail';
import { renderTemplate } from './message-templates';

/** Carrier and tracking number are cut to this length in a text message (a mail keeps 120). */
const SMS_FIELD_MAX = 40;

/** Two segments of text; the order link is the Market page plus an id, so it is not capped. */
export const SMS_MAX_LENGTH = 320;

const smsField = (value: string): string => {
  const flat = plainLine(value);
  return flat.length > SMS_FIELD_MAX ? `${flat.slice(0, SMS_FIELD_MAX - 3)}...` : flat;
};

export function orderShippedSms(input: {
  readonly orderId: string;
  readonly carrier: string;
  readonly trackingRef: string | null;
  readonly orderUrl: string;
  readonly locale?: string;
}): string {
  return renderTemplate('order-shipped-sms', input.locale ?? 'en', {
    orderId: input.orderId,
    carrier: smsField(input.carrier),
    tracking: input.trackingRef === null ? '' : ` Tracking number ${smsField(input.trackingRef)}.`,
    orderUrl: input.orderUrl,
  }).text;
}
