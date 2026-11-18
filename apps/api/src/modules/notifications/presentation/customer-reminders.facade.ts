import type { CallContext } from '@mondapac/shared-kernel';
import type { AdminCustomerCartReminders } from '../application/use-cases/admin-customer-cart-reminders.use-case';
import type {
  AdminCartRemindersRequest,
  CustomerRemindersFacade,
} from '../contracts/customer-reminders.facade';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class CustomerRemindersFacadeImplementation implements CustomerRemindersFacade {
  constructor(private readonly reminders: AdminCustomerCartReminders) {}

  adminCustomerCartReminders(context: CallContext, request: AdminCartRemindersRequest) {
    return this.reminders.execute(context, request);
  }
}
