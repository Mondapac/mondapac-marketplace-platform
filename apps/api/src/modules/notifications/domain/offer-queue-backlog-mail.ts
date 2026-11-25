// The Offer review queue backlog mail (risk-based Offer approval, slice 8b). Plain text, counts
// only: the reason with the limits set in Settings, the queue size and the oldest wait in business
// hours, and the Market id. No seller, Offer, product or person data, and no link. The text lives
// in `message-templates.ts`; Reza's review set the wording.

import { renderTemplate } from './message-templates';
import type { ComposedMail } from './order-mail';
import type { OfferQueueBacklogLimits, OfferQueueBacklogReason } from './offer-queue-backlog';

const plural = (n: number, one: string, other: string): string => `${n} ${n === 1 ? one : other}`;

const businessHours = (n: number): string => plural(n, 'business hour', 'business hours');

/**
 * The wait as the mail states it. The assessment floors to whole hours, so a wait just past the
 * limit floors to the limit itself: "at least" keeps the line true next to "more than the limit".
 */
const waited = (hours: number): string =>
  hours < 1 ? 'less than 1 business hour' : `at least ${businessHours(hours)}`;

function summary(reason: OfferQueueBacklogReason, limits: OfferQueueBacklogLimits): string {
  const count = `More than ${plural(limits.count, 'Offer is', 'Offers are')} waiting`;
  const age = `the oldest has waited more than ${businessHours(limits.hours)}`;
  if (reason === 'size') return `${count}, the limit in Settings.`;
  if (reason === 'age') {
    return `The oldest Offer has waited more than ${businessHours(limits.hours)}, the limit in Settings.`;
  }
  return `${count}, and ${age} (the limits in Settings).`;
}

function headline(reason: OfferQueueBacklogReason, count: number, hours: number): string {
  const offers = plural(count, 'Offer', 'Offers');
  const oldest = hours < 1 ? 'less than 1 business hour' : businessHours(hours);
  if (reason === 'size') return `${offers} waiting`;
  if (reason === 'age') return `oldest waited ${oldest}`;
  return `${offers} waiting, oldest ${oldest}`;
}

/** The mail for one crossing; the same text for every recipient. */
export function offerQueueBacklogMail(input: {
  readonly reason: OfferQueueBacklogReason;
  readonly limits: OfferQueueBacklogLimits;
  readonly count: number;
  readonly hours: number;
  readonly marketId: string;
  readonly locale?: string;
}): ComposedMail {
  return renderTemplate('offer-queue-backlog-alert', input.locale ?? 'en', {
    headline: headline(input.reason, input.count, input.hours),
    summary: summary(input.reason, input.limits),
    marketId: input.marketId,
    count: String(input.count),
    hours: waited(input.hours),
  });
}
