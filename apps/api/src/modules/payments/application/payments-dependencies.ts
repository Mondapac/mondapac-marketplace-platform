import type { Clock } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { OrderingFacade } from '../../ordering';
import type { ConnectedAccountStore } from './ports/connected-account-store';
import type { ConnectGateway } from './ports/connect-gateway';
import type { PaymentsPolicy } from './ports/payments-policy';
import type { StripeEventInbox } from './ports/stripe-event-inbox';
import type { StripeSessionReader } from './ports/stripe-session-reader';
import type { StripeSignature } from './ports/stripe-signature';

/** What every payments use case is built from. */
export interface PaymentsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inbox: StripeEventInbox;
  readonly signature: StripeSignature;
  readonly reader: StripeSessionReader;
  readonly ordering: OrderingFacade;
  readonly accounts: ConnectedAccountStore;
  readonly connect: ConnectGateway;
  readonly policy: PaymentsPolicy;
  readonly clock: Clock;
}
