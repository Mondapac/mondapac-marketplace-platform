import type { Clock } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { FlatFeeRepository } from './ports/flat-fee.repository';
import type { SellerDirectory } from './ports/seller-directory';
import type { ShippingPolicy } from './ports/shipping-policy';

/** What every shipping use case may need; one object built from the same ports. */
export interface ShippingDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly fees: FlatFeeRepository;
  readonly policy: ShippingPolicy;
  readonly sellers: SellerDirectory;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}
