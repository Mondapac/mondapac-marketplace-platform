import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { SecurityEvents } from '../../../platform/security-events/security-events';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { IdentityFacade } from '../../identity';
import type { OrderingFacade } from '../../ordering';
import type { ConnectedAccountStore } from './ports/connected-account-store';
import type { ConnectGateway } from './ports/connect-gateway';
import type { DisputeStore } from './ports/dispute-store';
import type { PaymentsPolicy } from './ports/payments-policy';
import type { StripeDisputeReader } from './ports/stripe-dispute-reader';
import type { StripeEventInbox } from './ports/stripe-event-inbox';
import type { StripeSessionReader } from './ports/stripe-session-reader';
import type { StripeSignature } from './ports/stripe-signature';

/** What every payments use case is built from. */
export interface PaymentsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly inbox: StripeEventInbox;
  readonly signature: StripeSignature;
  readonly reader: StripeSessionReader;
  readonly disputeReader: StripeDisputeReader;
  readonly disputes: DisputeStore;
  /** Payments' own outbox (package 8a: `payments.dispute-changed.v1`). */
  readonly outbox: OutboxWriter;
  readonly ordering: OrderingFacade;
  readonly accounts: ConnectedAccountStore;
  readonly connect: ConnectGateway;
  readonly policy: PaymentsPolicy;
  /**
   * What payments asks of identity: the actor's factor state, a recent-confirmation check, and
   * the Seller Owner's own address that Stripe requires to create the payout account.
   */
  readonly identity: Pick<
    IdentityFacade,
    'describeActor' | 'confirmSecondFactor' | 'ownOwnerEmail'
  >;
  readonly audit: AuditWriter;
  readonly securityEvents: SecurityEvents;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
