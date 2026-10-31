import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuthorisationCheck, StepUpProofConsumer } from '../../../platform/authz';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { SecurityEvents } from '../../../platform/security-events/security-events';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { DisputeSource, OrderPaymentLookup } from './ports/dispute-source';
import type { DisputeRepository } from './ports/dispute.repository';
import type { LedgerRepository } from './ports/ledger.repository';
import type { PayoutCursorRepository } from './ports/payout-cursor.repository';
import type { PayoutHoldRepository } from './ports/payout-hold.repository';
import type { SellerNames } from './ports/seller-names';

/** What the dispute use cases need (package 8b); built from the same ports as the others. */
export interface DisputeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly disputes: DisputeRepository;
  readonly ledger: LedgerRepository;
  readonly holds: PayoutHoldRepository;
  /** The seller's money lock, taken before a hold or a debit changes what a payout may take. */
  readonly cursors: PayoutCursorRepository;
  readonly source: DisputeSource;
  readonly orders: OrderPaymentLookup;
  readonly sellerNames: SellerNames;
  readonly outbox: OutboxWriter;
  readonly securityEvents: SecurityEvents;
  /** Asked whether a seller-side reader also holds `commission-payouts.earnings.view`. */
  readonly authorisation: AuthorisationCheck;
  /** Spends the admin step-up of a decision once, in the decision's own unit. */
  readonly stepUp: StepUpProofConsumer;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
