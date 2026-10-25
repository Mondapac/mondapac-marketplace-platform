import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { IdentityFacade } from '../../identity';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { MarketSettingRepository } from './ports/market-setting.repository';
import type { WalletPolicy } from './ports/wallet-policy';
import type { WalletRepository } from './ports/wallet.repository';

/** What every wallet use case may need; one object built from the same ports. */
export interface WalletDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly wallet: WalletRepository;
  readonly settings: MarketSettingRepository;
  readonly policy: WalletPolicy;
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** The admin step-up check (issue #491): identity's answer for a registered admin action. */
  readonly identity: Pick<IdentityFacade, 'requireStepUp'>;
}
