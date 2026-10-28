import type { CallContext } from '@mondapac/shared-kernel';
import type { CancelAccountDeletion } from '../application/use-cases/cancel-account-deletion.use-case';
import type { CustomersAccountDeletionFacade } from '../contracts/account-deletion.facade';

/** Passes the caller's `CallContext` unchanged to the one use case, so the gate runs. */
export class CustomersAccountDeletionFacadeImplementation implements CustomersAccountDeletionFacade {
  constructor(private readonly cancel: CancelAccountDeletion) {}

  cancelPendingOnSignIn(context: CallContext) {
    return this.cancel.execute(context, { reason: 'sign-in' });
  }
}
