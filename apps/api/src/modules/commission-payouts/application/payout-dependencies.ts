import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { StepUpProofConsumer } from '../../../platform/authz';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { SecurityEvents } from '../../../platform/security-events/security-events';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { PayoutTermsResolver } from './payout-terms-resolver';
import type { CommissionPolicy } from './ports/commission-policy';
import type { EligibilityAnchorRepository } from './ports/eligibility-anchor.repository';
import type { LedgerRepository } from './ports/ledger.repository';
import type { PayoutCursorRepository } from './ports/payout-cursor.repository';
import type {
  PaymentsPayouts,
  PayoutPolicy,
  PayoutPrerequisites,
  SellerPayoutAccess,
} from './ports/payout-gateways';
import type { PayoutHoldRepository } from './ports/payout-hold.repository';
import type { PayoutRepository } from './ports/payout.repository';
import type { SellerNames } from './ports/seller-names';

/** What the payout use cases need (package 6d); built from the same ports as the others. */
export interface PayoutDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly payouts: PayoutRepository;
  readonly cursors: PayoutCursorRepository;
  readonly ledger: LedgerRepository;
  readonly anchors: EligibilityAnchorRepository;
  readonly holds: PayoutHoldRepository;
  readonly terms: PayoutTermsResolver;
  readonly policy: CommissionPolicy;
  readonly payoutPolicy: PayoutPolicy;
  readonly access: SellerPayoutAccess;
  readonly prerequisites: PayoutPrerequisites;
  readonly payments: PaymentsPayouts;
  readonly sellerNames: SellerNames;
  readonly securityEvents: SecurityEvents;
  /** Spends the admin step-up of an approval once, in the approval's own unit. */
  readonly stepUp: StepUpProofConsumer;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
