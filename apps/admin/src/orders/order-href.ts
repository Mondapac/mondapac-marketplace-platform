/** The customer page tab an order was opened from, so the order's Back returns to it. */
export interface CustomerOrigin {
  readonly accountId: string;
  readonly tab: 'orders' | 'money';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One order's page; from a customer's tab it names that customer and tab (ids only). */
export function orderHref(orderId: string, from?: CustomerOrigin): string {
  const path = `/orders/${encodeURIComponent(orderId)}`;
  if (from === undefined) return path;
  const query = new URLSearchParams({ customer: from.accountId, from: from.tab });
  return `${path}?${query.toString()}`;
}

/** The origin an order page's address names, or undefined when it names none or a bad one. */
export function customerOriginOf(
  customer: string | string[] | undefined,
  from: string | string[] | undefined,
): CustomerOrigin | undefined {
  if (typeof customer !== 'string' || !UUID.test(customer)) return undefined;
  if (from !== 'orders' && from !== 'money') return undefined;
  return { accountId: customer.toLowerCase(), tab: from };
}

/** Where Back goes from an order: the customer's tab it came from, else the orders list. */
export function backHrefOf(from: CustomerOrigin | undefined): string {
  return from === undefined
    ? '/orders'
    : `/customers/${encodeURIComponent(from.accountId)}?tab=${from.tab}`;
}
