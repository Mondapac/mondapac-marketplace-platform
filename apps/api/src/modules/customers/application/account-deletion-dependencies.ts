import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type {
  EngagementPeer,
  IdentityPeer,
  OrderingPeer,
  ReviewsPeer,
  WalletPeer,
} from './ports/account-deletion-peers';
import type { AccountDeletionRequestRepository } from './ports/account-deletion-request.repository';
import type { AccountDeletionSettingsRepository } from './ports/account-deletion-settings.repository';
import type { AddressRepository } from './ports/address.repository';

/**
 * What the buyer deletion flow needs (package 5b): its own ports and the facades of the modules it
 * asks, as local peer interfaces bound at start by `CustomersAccountDeletionModule` (customers
 * cannot import `ordering` without a cycle, as `ordering` imports customers). A separate object
 * from `CustomersDependencies`, which the address book use cases share.
 */
export interface AccountDeletionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly requests: AccountDeletionRequestRepository;
  readonly addresses: AddressRepository;
  readonly accountDeletionSettings: AccountDeletionSettingsRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  /** Ends the other sessions and, for the job, erases the account (key destroyed). */
  readonly identity: IdentityPeer;
  /** The wallet balance, a blocker. */
  readonly wallet: WalletPeer;
  /** Open orders and pending refunds, blockers. */
  readonly ordering: OrderingPeer;
  /** Forgets the account's behaviour. */
  readonly engagement: EngagementPeer;
  /** Detaches the author from the account's reviews and ratings (they stay as "Former customer"). */
  readonly reviews: ReviewsPeer;
}
