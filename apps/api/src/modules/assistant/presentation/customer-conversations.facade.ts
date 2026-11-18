import type { CallContext } from '@mondapac/shared-kernel';
import type { AdminCustomerConversations } from '../application/use-cases/admin-customer-conversations.use-case';
import type {
  AdminConversationsRequest,
  CustomerConversationsFacade,
} from '../contracts/customer-conversations.facade';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class CustomerConversationsFacadeImplementation implements CustomerConversationsFacade {
  constructor(private readonly conversations: AdminCustomerConversations) {}

  adminCustomerConversations(context: CallContext, request: AdminConversationsRequest) {
    return this.conversations.execute(context, request);
  }
}
