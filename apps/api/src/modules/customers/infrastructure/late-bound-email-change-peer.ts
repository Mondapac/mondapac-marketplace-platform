import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { EmailChangePeer } from '../application/ports/email-change-peer';

const UNAVAILABLE = () => Promise.resolve(err({ code: 'customers.unavailable' }));

/**
 * identity's side of the admin email change, refusing (fail closed) until
 * `CustomersAccountDeletionModule` binds the real facade at start. Every method forwards.
 */
export class LateBoundEmailChangePeer implements EmailChangePeer {
  #bound: EmailChangePeer | null = null;

  bind(peer: EmailChangePeer): void {
    this.#bound = peer;
  }

  requestCustomerEmailChangeForAdmin(
    context: CallContext,
    request: { readonly accountId: Id<'Account'>; readonly email: string; readonly origin: string },
  ) {
    return this.#bound === null
      ? UNAVAILABLE()
      : this.#bound.requestCustomerEmailChangeForAdmin(context, request);
  }

  cancelCustomerEmailChangeForAdmin(context: CallContext, accountId: Id<'Account'>) {
    return this.#bound === null
      ? UNAVAILABLE()
      : this.#bound.cancelCustomerEmailChangeForAdmin(context, accountId);
  }

  customerPendingEmailOf(context: CallContext, accountId: Id<'Account'>) {
    return this.#bound === null
      ? UNAVAILABLE()
      : this.#bound.customerPendingEmailOf(context, accountId);
  }
}
