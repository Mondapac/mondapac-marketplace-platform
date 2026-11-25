// The address of the Orders list opened on a filter (dashboards v2 drill-down): a dashboard card,
// chart part or work-queue row links here. Only the names and values the list's own reader takes
// (`queryFromParams` in orders-query.ts) are written; any other value is dropped, so a link never
// carries free text from an answer, and never an id of a person.

import { isDatePreset } from '../sales/date-presets.ts';
import { DAY, startOfDay } from '../sales/day-start.ts';
import { FULFILMENT_FILTERS, PAYMENT_FILTERS } from './orders-query.ts';
import { STATUSES } from './types.ts';

export const ORDERS_PATH = '/orders';

/** What a link asks the list for; each value is checked against the list's own set. */
export interface OrdersLink {
  /** The status tab (`pending-payment`, `confirmed`, `cancelled`). */
  readonly status?: string;
  /** `to-ship`, `shipped` or `delivered`. */
  readonly fulfilment?: string;
  /** `none`, `authorised`, `captured` or `voided`. */
  readonly paymentState?: string;
  /** A placed-day preset (`today`, `last-7-days`, ...); it replaces `from`/`to`. */
  readonly placed?: string;
  /** The first placed day, yyyy-mm-dd (included). */
  readonly from?: string;
  /** The last placed day, yyyy-mm-dd (included). */
  readonly to?: string;
}

const known = (set: readonly string[], value: string | undefined): string | undefined =>
  value !== undefined && set.includes(value) ? value : undefined;

/** A real calendar day (the list reads it the same way). */
const day = (value: string | undefined): string | undefined =>
  value !== undefined && DAY.test(value) && startOfDay(value, 'UTC') !== null ? value : undefined;

/** `/orders` with the known filters of `link`, in a fixed order, URL-encoded. */
export function ordersHref(link: OrdersLink = {}): string {
  const params = new URLSearchParams();
  const status = known(STATUSES, link.status);
  if (status !== undefined) params.set('status', status);
  const fulfilment = known(FULFILMENT_FILTERS, link.fulfilment);
  if (fulfilment !== undefined) params.set('fulfilment', fulfilment);
  const payment = known(PAYMENT_FILTERS, link.paymentState);
  if (payment !== undefined) params.set('paymentState', payment);
  if (isDatePreset(link.placed)) {
    params.set('placed', link.placed);
  } else {
    const from = day(link.from);
    const to = day(link.to);
    // A backwards range would open a list that matches nothing: it is left out.
    if (!(from !== undefined && to !== undefined && to < from)) {
      if (from !== undefined) params.set('from', from);
      if (to !== undefined) params.set('to', to);
    }
  }
  const query = params.toString();
  return query === '' ? ORDERS_PATH : `${ORDERS_PATH}?${query}`;
}
