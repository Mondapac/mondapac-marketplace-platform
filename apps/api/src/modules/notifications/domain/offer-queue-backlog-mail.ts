// The Offer review queue backlog mail (risk-based Offer approval, slice 8b). Plain text, counts
// only: the reason, the queue size and the oldest wait in whole business hours, and the Market
// id. No seller, Offer, product or person data, and no link. The text lives in
// `message-templates.ts`.

import { renderTemplate } from './message-templates';
import type { ComposedMail } from './order-mail';
import type { OfferQueueBacklogReason } from './offer-queue-backlog';

const SUMMARY: Readonly<Record<OfferQueueBacklogReason, string>> = {
  age: 'The oldest Offer has waited longer than the limit set in Settings.',
  size: 'More Offers are waiting than the limit set in Settings.',
  both: 'More Offers are waiting than the limit set in Settings, and the oldest has waited longer than its limit.',
};

const plural = (n: number, one: string, other: string): string => `${n} ${n === 1 ? one : other}`;

/** The mail for one crossing; the same text for every recipient. */
export function offerQueueBacklogMail(input: {
  readonly reason: OfferQueueBacklogReason;
  readonly count: number;
  readonly hours: number;
  readonly marketId: string;
  readonly locale?: string;
}): ComposedMail {
  return renderTemplate('offer-queue-backlog-alert', input.locale ?? 'en', {
    summary: SUMMARY[input.reason],
    marketId: input.marketId,
    count: String(input.count),
    hours: plural(input.hours, 'business hour', 'business hours'),
  });
}
