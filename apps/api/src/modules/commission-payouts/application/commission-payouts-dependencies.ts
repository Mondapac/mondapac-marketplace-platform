import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CommissionPolicy } from './ports/commission-policy';
import type { LedgerRepository } from './ports/ledger.repository';
import type { SellerDirectory } from './ports/seller-directory';
import type { SellerRateRepository } from './ports/seller-rate.repository';

/** What every commission-payouts use case may need; one object built from the same ports. */
export interface CommissionPayoutsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly rates: SellerRateRepository;
  readonly ledger: LedgerRepository;
  readonly policy: CommissionPolicy;
  readonly sellers: SellerDirectory;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
