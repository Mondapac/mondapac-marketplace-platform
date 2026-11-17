import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { AdminCustomerBehaviour } from '../application/use-cases/admin-customer-behaviour.use-case';
import type { AdminCustomerCartAdditions } from '../application/use-cases/admin-customer-cart-additions.use-case';
import type {
  AdminCartAdditionsRequest,
  CustomerBehaviourFacade,
} from '../contracts/customer-behaviour.facade';

/** Passes the caller's `CallContext` unchanged to each use case, so the gate runs. */
export class CustomerBehaviourFacadeImplementation implements CustomerBehaviourFacade {
  constructor(
    private readonly behaviour: AdminCustomerBehaviour,
    private readonly additions: AdminCustomerCartAdditions,
  ) {}

  adminCustomerBehaviour(context: CallContext, accountId: Id<'Account'>) {
    return this.behaviour.execute(context, { accountId });
  }

  adminCustomerCartAdditions(context: CallContext, request: AdminCartAdditionsRequest) {
    return this.additions.execute(context, request);
  }
}
