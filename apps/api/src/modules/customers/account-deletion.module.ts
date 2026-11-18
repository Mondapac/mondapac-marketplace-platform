import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ENGAGEMENT_FACADE, EngagementModule, type EngagementFacade } from '../engagement';
import { IDENTITY_FACADE, IdentityModule, type IdentityFacade } from '../identity';
import { ORDERING_FACADE, OrderingModule, type OrderingFacade } from '../ordering';
import { REVIEWS_FACADE, ReviewsModule, type ReviewsFacade } from '../reviews';
import { WALLET_FACADE, WalletModule, type WalletFacade } from '../wallet';
import { ACCOUNT_DELETION_PEERS } from './application/ports/account-deletion-peers';
import type { LateBoundAccountDeletionPeers } from './infrastructure/late-bound-account-deletion-peers';
import { EMAIL_CHANGE_PEER } from './application/ports/email-change-peer';
import type { LateBoundEmailChangePeer } from './infrastructure/late-bound-email-change-peer';
import { CustomersModule } from './customers.module';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { CancelEmailChangeOnDeletion } from './application/use-cases/cancel-email-change-on-deletion.use-case';
import { emailChangeOnDeletionSubscriptions } from './presentation/subscribers/email-change-on-deletion.subscriptions';

/**
 * Binds the buyer deletion flow (customers package 5b) to the modules it asks. It is a module of
 * its own because `ordering` imports `customers`: `CustomersModule` provides the use cases, the
 * routes and the job with peers that refuse (fail closed) until this module binds the real
 * `ordering`, `wallet`, `identity`, `engagement` and `reviews` facades at start, and this module (which
 * imports all five) is registered beside them in `modules/index.ts`. It is not exported from the
 * customers entry point, so no file cycle forms.
 */
@Module({
  imports: [
    CustomersModule,
    IdentityModule,
    WalletModule,
    OrderingModule,
    EngagementModule,
    ReviewsModule,
  ],
  providers: [
    // A requested deletion cancels a pending sign-in email change in identity (Hassan R6, L2).
    registerSubscriptionsFrom(
      'customers',
      [CancelEmailChangeOnDeletion],
      (cancel: CancelEmailChangeOnDeletion) => emailChangeOnDeletionSubscriptions(cancel),
    ),
  ],
})
export class CustomersAccountDeletionModule implements OnModuleInit {
  constructor(
    @Inject(ACCOUNT_DELETION_PEERS) private readonly peers: LateBoundAccountDeletionPeers,
    @Inject(EMAIL_CHANGE_PEER) private readonly emailChange: LateBoundEmailChangePeer,
    @Inject(IDENTITY_FACADE) private readonly identity: IdentityFacade,
    @Inject(WALLET_FACADE) private readonly wallet: WalletFacade,
    @Inject(ORDERING_FACADE) private readonly ordering: OrderingFacade,
    @Inject(ENGAGEMENT_FACADE) private readonly engagement: EngagementFacade,
    @Inject(REVIEWS_FACADE) private readonly reviews: ReviewsFacade,
  ) {}

  onModuleInit(): void {
    // The admin email change (customers admin email change) asks identity only.
    this.emailChange.bind(this.identity);
    this.peers.bind({
      identity: this.identity,
      wallet: this.wallet,
      ordering: this.ordering,
      engagement: this.engagement,
      reviews: this.reviews,
    });
  }
}
