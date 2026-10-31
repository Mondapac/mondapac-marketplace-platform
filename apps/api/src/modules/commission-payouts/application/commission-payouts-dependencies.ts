import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { StepUpProofConsumer } from '../../../platform/authz';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { PayoutTermsResolver } from './payout-terms-resolver';
import type { CommissionPolicy } from './ports/commission-policy';
import type { EligibilityAnchorRepository } from './ports/eligibility-anchor.repository';
import type { PayoutCursorRepository } from './ports/payout-cursor.repository';
import type { PayoutHoldRepository } from './ports/payout-hold.repository';
import type { PayoutTermsRepository } from './ports/payout-terms.repository';
import type { LedgerRepository } from './ports/ledger.repository';
import type { SellerDirectory } from './ports/seller-directory';
import type { SellerRateRepository } from './ports/seller-rate.repository';

/** What every commission-payouts use case may need; one object built from the same ports. */
export interface CommissionPayoutsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly rates: SellerRateRepository;
  readonly ledger: LedgerRepository;
  readonly policy: CommissionPolicy;
  /** A seller's own payout terms (package 6b). */
  readonly termsOverrides: PayoutTermsRepository;
  /** The effective payout terms: the Market's with the seller's override over them. */
  readonly terms: PayoutTermsResolver;
  readonly anchors: EligibilityAnchorRepository;
  readonly holds: PayoutHoldRepository;
  readonly sellers: SellerDirectory;
  /** The payout schedule cursors: created with a seller's first anchor, reset by a terms change. */
  readonly cursors: PayoutCursorRepository;
  readonly outbox: OutboxWriter;
  /** Spends the admin step-up of a protected action once, in the action's own unit. */
  readonly stepUp: StepUpProofConsumer;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
