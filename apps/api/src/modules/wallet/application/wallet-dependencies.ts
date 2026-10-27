import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { StepUpProofConsumer } from '../../../platform/authz';
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
  /**
   * Spends the admin step-up proof of the switch once, inside the unit that saves it (issue #491;
   * identity implements the platform port).
   */
  readonly stepUp: StepUpProofConsumer;
}
