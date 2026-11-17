import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Money, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type PermissionKey,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isActingAsSession } from '../acting-as';
import type {
  CustomerPaymentFact,
  CustomerPaymentsQuery,
  CustomerPaymentsReader,
  CustomerPaymentsSort,
} from '../ports/customer-payments.reader';

/**
 * The key `payments` declared for a customer's payments and disputes (customers management phase
 * 2b): the payments use cases ask ordering for the facts, so ordering's facade use cases declare
 * the same key. Only payments can brand it; a contract test pins the literal to the declaration.
 */
export const PAYMENTS_CUSTOMER_PAYMENT_VIEW = 'payments.customer-payment.view' as PermissionKey;

export interface CustomerPaymentsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly payments: CustomerPaymentsReader;
}

export interface CustomerPaymentsRequest {
  readonly query: CustomerPaymentsQuery;
  readonly order: { readonly sort: CustomerPaymentsSort; readonly direction: 'asc' | 'desc' };
  readonly window: { readonly offset: number; readonly limit: number };
  /** Count every match (page-number mode); false in Previous and Next mode. */
  readonly withTotal: boolean;
}

export interface CustomerPaymentsPage {
  readonly rows: readonly CustomerPaymentFact[];
  readonly total: number | null;
  /** The captured orders' totals, one per currency: the customer page's "Paid". */
  readonly paid: readonly Money[];
}

export type AdminCustomerPaymentsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

/** At most this many rows in one call (the export's cap plus the overflow row). */
export const CUSTOMER_PAYMENTS_MAX_WINDOW = 10_001;

export const isAdmin = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' &&
  context.actor.population === 'admin' &&
  !isActingAsSession(context.actor);

/**
 * `ordering.admin-customer-payments`: one customer's orders as payments, for payments' customer
 * page reads (phase 2b, gaps c and f). Rule: `permissions [payments.customer-payment.view]`, a
 * platform admin not acting as a seller. payments validates the request; this checks its bounds.
 * In-process only (the facade), never over HTTP.
 */
export class AdminCustomerPayments extends UseCase<
  CustomerPaymentsRequest,
  CustomerPaymentsPage,
  AdminCustomerPaymentsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-customer-payments',
    rule: { kind: 'permissions', allOf: [PAYMENTS_CUSTOMER_PAYMENT_VIEW] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerPaymentsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    request: CustomerPaymentsRequest,
  ): Promise<Result<CustomerPaymentsPage, AdminCustomerPaymentsFailure>> {
    if (!isAdmin(context)) return err({ code: 'access.denied' });
    const limit = Math.min(Math.max(request.window.limit, 0), CUSTOMER_PAYMENTS_MAX_WINDOW);
    const read = await this.deps.unitOfWork.run(
      context.market,
      async () => {
        const [rows, total, paid] = await Promise.all([
          this.deps.payments.page(context.market, request.query, request.order, {
            offset: Math.max(request.window.offset, 0),
            limit,
          }),
          request.withTotal
            ? this.deps.payments.count(context.market, request.query)
            : Promise.resolve(null),
          this.deps.payments.paidTotals(context.market, request.query.accountId),
        ]);
        return ok({ rows, total, paid });
      },
      { readOnly: true },
    );
    return read.ok ? read : err({ code: 'access.unavailable' });
  }
}
