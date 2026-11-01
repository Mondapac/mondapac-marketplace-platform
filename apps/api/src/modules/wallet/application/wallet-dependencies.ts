import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { IdentityFacade } from '../../identity';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { ChangeTrail } from '../../../platform/audit/change-trail';
import type { StepUpProofConsumer } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { AdminCreditRepository } from './ports/admin-credit.repository';
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
  /** "Last changed by" and the history of the switch, from this module's audit rows. */
  readonly trail: ChangeTrail;
}

/** The admin credit use cases (package 2a) also reach the request store. */
export interface AdminCreditDependencies extends WalletDependencies {
  readonly credits: AdminCreditRepository;
  /**
   * Whether the customer id names an active customer account of the Market (review S1), read
   * through identity's facade, never its tables.
   */
  readonly identity: Pick<IdentityFacade, 'customerAccountOf'>;
}
