// Answers of the seller Customers routes (apps/api customers/presentation/seller-customers and
// seller-invite-link controllers). A seller sees a customer by the shop's code and the first name
// only: never an email or an account id.

export const CUSTOMERS_VIEW_PERMISSION = 'customers.seller-customers.view';
export const CUSTOMERS_EXPORT_PERMISSION = 'customers.seller-customers.export';
export const INVITE_LINK_PERMISSION = 'customers.seller-invite-link.manage';

export const CUSTOMER_VIEWS = ['all', 'buyers', 'followers', 'referred'] as const;
export type CustomerView = (typeof CUSTOMER_VIEWS)[number];

export interface SellerCustomerRow {
  readonly code: string;
  readonly firstName: string | null;
  readonly orderCount: number;
  readonly firstOrderAt: string | null;
  readonly lastOrderAt: string | null;
  /** Minor units as digits; null when the customer never bought from the shop. */
  readonly spentMinor: string | null;
  readonly currency: string | null;
  readonly follower: boolean;
  readonly followedAt: string | null;
  readonly exclusive: boolean;
  /** The first order or follow date: "Customer since". */
  readonly since: string;
}

export interface SellerCustomerPage {
  readonly items: readonly SellerCustomerRow[];
  readonly counts: Readonly<Record<CustomerView, number>>;
  readonly paging: {
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    readonly maxRows: number;
  } | null;
  readonly nextCursor: string | null;
}

export interface SellerCustomerOrder {
  readonly sellerOrderId: string;
  readonly orderId: string;
  readonly paidAt: string;
  readonly totalMinor: string;
  readonly currency: string;
  readonly fulfilment: 'to-ship' | 'shipped' | 'delivered';
  readonly deliveredAt: string | null;
}

export interface SellerCustomerDetail {
  readonly customer: SellerCustomerRow;
  /** Null without `ordering.seller-order.view`. */
  readonly orders: {
    readonly items: readonly SellerCustomerOrder[];
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
  } | null;
}

export interface InviteLinkAnswer {
  readonly link: { readonly token: string; readonly createdAt: string } | null;
  /** Customers who joined through any of the shop's links, by attribution status. */
  readonly signups: { readonly active: number; readonly rejected: number };
}
