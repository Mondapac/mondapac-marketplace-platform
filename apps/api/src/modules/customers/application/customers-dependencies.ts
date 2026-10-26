import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { StepUpProofConsumer } from '../../../platform/authz';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { AccountDeletionSettingsRepository } from './ports/account-deletion-settings.repository';
import type { AddressCipher } from './ports/address-cipher';
import type { AddressPolicy } from './ports/address-policy';
import type { AddressRepository } from './ports/address.repository';

/** What every customers use case may need; one object built from the same ports. */
export interface CustomersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly addresses: AddressRepository;
  readonly cipher: AddressCipher;
  readonly policy: AddressPolicy;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly accountDeletionSettings: AccountDeletionSettingsRepository;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  /**
   * Spends the admin step-up proof of a setting change once, inside the unit that saves it
   * (identity implements it; the same consumer the wallet switch uses).
   */
  readonly stepUp: StepUpProofConsumer;
}
