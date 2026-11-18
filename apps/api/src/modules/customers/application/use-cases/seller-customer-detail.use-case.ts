import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_SELLER_CUSTOMERS_VIEW } from '../../contracts/permissions';
import {
  customerCodeOf,
  invalid,
  isRecord,
  sellerOfCall,
  sellerRowOfRecord,
  type SellerCustomerDependencies,
  type SellerCustomerRowView,
} from '../seller-customers-flow';
import type { SellerCustomersReadFailure } from './seller-customers-list.use-case';

/** Seller orders per page of a customer's page. */
export const SELLER_CUSTOMER_ORDERS_PAGE_MAX = 100;
const DEFAULT_ORDERS_PAGE = 20;

export interface SellerCustomerOrderView {
  readonly sellerOrderId: string;
  readonly orderId: string;
  readonly paidAt: string;
  readonly totalMinor: string;
  readonly currency: string;
  readonly fulfilment: 'to-ship' | 'shipped' | 'delivered';
  readonly deliveredAt: string | null;
}

export interface SellerCustomerDetailOutput {
  readonly customer: SellerCustomerRowView;
  /** Null when the member may not see the shop's orders (`ordering.seller-order.view`). */
  readonly orders: {
    readonly items: readonly SellerCustomerOrderView[];
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
  } | null;
}

export type SellerCustomerDetailFailure =
  SellerCustomersReadFailure | { readonly code: 'customers.seller-customer-not-found' };

/**
 * `customers.seller-customer-detail`: one of the shop's customers by the code the shop knows them
 * by, with a page of the shop's own paid seller orders of that customer, newest first. Another
 * shop's code, or a code never given, is not found (the same answer). The customer's account is
 * looked up here and handed to `ordering` with the seller's `CallContext` unchanged (that read
 * checks `ordering.seller-order.view` itself); it is never answered. Rule as the list.
 */
export class SellerCustomerDetail extends UseCase<
  unknown,
  SellerCustomerDetailOutput,
  SellerCustomerDetailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.seller-customer-detail',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_SELLER_CUSTOMERS_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCustomerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<SellerCustomerDetailOutput, SellerCustomerDetailFailure>> {
    const sellerId = sellerOfCall(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (!isRecord(input)) return invalid('body', 'type');
    for (const key of Object.keys(input)) {
      if (key !== 'code' && key !== 'page' && key !== 'pageSize') return invalid(key, 'unknown');
    }
    const code = customerCodeOf(input['code']);
    if (code === null) return invalid('code', 'format');
    const whole = (value: unknown, fallback: number, max: number) =>
      value === undefined
        ? fallback
        : typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max
          ? value
          : null;
    const page = whole(input['page'], 1, 1000);
    if (page === null) return invalid('page', 'range');
    const pageSize = whole(input['pageSize'], DEFAULT_ORDERS_PAGE, SELLER_CUSTOMER_ORDERS_PAGE_MAX);
    if (pageSize === null) return invalid('pageSize', 'range');

    const { deps } = this;
    const found = await deps.unitOfWork.run(
      context.market,
      async () => ok(await deps.sellerCustomers.findByCode(context.market, sellerId, code)),
      { readOnly: true },
    );
    if (!found.ok) return err({ code: 'access.unavailable' });
    const record = found.value;
    if (record === null) return err({ code: 'customers.seller-customer-not-found' });

    const customer = sellerRowOfRecord(record);
    if (record.orderCount === 0) {
      return ok({ customer, orders: { items: [], total: 0, page, pageSize } });
    }
    const orders = await deps.ordering.sellerCustomerOrders(context, {
      accountId: record.accountId,
      page,
      pageSize,
    });
    if (!orders.ok) {
      if (orders.error.code === 'access.denied') return ok({ customer, orders: null });
      return err({ code: 'access.unavailable' });
    }
    return ok({
      customer,
      orders: {
        items: orders.value.items.map((order) => ({
          sellerOrderId: order.sellerOrderId,
          orderId: order.orderId,
          paidAt: order.paidAt.toString(),
          totalMinor: order.total.amount.toString(),
          currency: order.total.currency,
          fulfilment: order.fulfilment,
          deliveredAt: order.deliveredAt === null ? null : order.deliveredAt.toString(),
        })),
        total: orders.value.total,
        page,
        pageSize,
      },
    });
  }
}
