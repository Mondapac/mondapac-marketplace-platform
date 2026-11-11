// The texts of the order emails (Phase 6 package 1, owner decision Q10). Plain text only: the
// mail transport sends no HTML, so user-entered text (product names) cannot become markup. A
// name is still flattened to one line without control or format characters, so it cannot break
// the layout of the message. The texts live in `message-templates.ts`. The label of the customer
// mail is "Order confirmation", never "Tax invoice" (the tax adviser has not confirmed the wording).

import { minorUnitExponent } from '@mondapac/shared-kernel';
import type { Money } from '@mondapac/shared-kernel';
import { renderTemplate } from './message-templates';

export interface MailLine {
  /** The product name as the seller entered it, or null when catalog has none. */
  readonly name: string | null;
  readonly quantity: number;
}

export interface ComposedMail {
  readonly subject: string;
  readonly text: string;
}

const FALLBACK_NAME = 'Item';
const MAX_NAME = 120;

/** One line of plain text from seller-entered text: no control or format characters. */
export function plainLine(value: string | null): string {
  const flat = (value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length === 0) return FALLBACK_NAME;
  return flat.length > MAX_NAME ? `${flat.slice(0, MAX_NAME - 1)}…` : flat;
}

const lineText = (line: MailLine): string => `- ${plainLine(line.name)} x ${line.quantity}`;

/** The customer's "Order confirmation": the reference, the lines and a link that needs sign-in. */
export function orderConfirmationMail(input: {
  readonly orderId: string;
  readonly lines: readonly MailLine[];
  readonly orderUrl: string;
  readonly locale?: string;
}): ComposedMail {
  const { subject, text } = renderTemplate('order-confirmation', input.locale ?? 'en', {
    orderId: input.orderId,
    items: input.lines.map(lineText).join('\n'),
    orderUrl: input.orderUrl,
  });
  return { subject, text };
}

/** The seller's "New order": the reference and the seller's own lines. No customer data. */
export function sellerNewOrderMail(input: {
  readonly sellerOrderId: string;
  readonly lines: readonly MailLine[];
  readonly locale?: string;
}): ComposedMail {
  const { subject, text } = renderTemplate('seller-new-order', input.locale ?? 'en', {
    sellerOrderId: input.sellerOrderId,
    items: input.lines.map(lineText).join('\n'),
  });
  return { subject, text };
}

/**
 * A link as it may go into a mail: an absolute `https` URL with no credentials, no space or
 * control character and at most 500 characters, re-serialised; anything else is null. A mail is
 * plain text, so the link is inert; the scheme check keeps `javascript:` and `http:` out anyway.
 */
export function httpsLink(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    const text = url.toString();
    return [...text].some((c) => c <= ' ' || c === '\u007f') ? null : text;
  } catch {
    return null;
  }
}

/** The seller's "Payment dispute" notice: the order reference only. No reason, amount or buyer data. */
export function sellerOrderDisputedMail(input: {
  readonly orderId: string;
  readonly locale?: string;
}): ComposedMail {
  const { subject, text } = renderTemplate('seller-order-disputed', input.locale ?? 'en', {
    orderId: input.orderId,
  });
  return { subject, text };
}

/** The customer's "Shipped": the carrier, the tracking number when there is one, and the order link. */
export function orderShippedMail(input: {
  readonly orderId: string;
  readonly carrier: string;
  readonly trackingRef: string | null;
  /** The fleet's tracking page; used only if it is a plain https URL ({@link httpsLink}). */
  readonly trackingUrl?: string | null;
  readonly orderUrl: string;
  readonly locale?: string;
}): ComposedMail {
  const link = httpsLink(input.trackingUrl);
  const { subject, text } = renderTemplate('order-shipped', input.locale ?? 'en', {
    orderId: input.orderId,
    carrier: plainLine(input.carrier),
    tracking:
      (input.trackingRef === null ? '' : `\nTracking number: ${plainLine(input.trackingRef)}`) +
      (link === null ? '' : `\nTrack your delivery: ${link}`),
    orderUrl: input.orderUrl,
  });
  return { subject, text };
}

/** An amount as the mail shows it, in the Market's locale (e.g. "A$15.00" or "¥1,500"). */
export function mailAmount(amount: Money, locale: string): string {
  const exponent = minorUnitExponent(amount.currency);
  const major = Number(amount.amount) / 10 ** exponent;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: amount.currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(major);
  } catch {
    return `${amount.currency} ${major.toFixed(exponent)}`;
  }
}

/**
 * The customer's "Part of your order is unavailable" (decision 6): the reference, how many units
 * were not supplied, what went back, and the order link. No product, seller or card data.
 */
export function itemUnavailableRefundMail(input: {
  readonly orderId: string;
  readonly units: number;
  readonly amount: Money;
  readonly orderUrl: string;
  readonly locale?: string;
}): ComposedMail {
  const locale = input.locale ?? 'en';
  const { subject, text } = renderTemplate('item-unavailable-refund', locale, {
    orderId: input.orderId,
    units: String(input.units),
    amount: mailAmount(input.amount, locale),
    orderUrl: input.orderUrl,
  });
  return { subject, text };
}
