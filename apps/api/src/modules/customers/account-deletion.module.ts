import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ENGAGEMENT_FACADE, EngagementModule, type EngagementFacade } from '../engagement';
import { IDENTITY_FACADE, IdentityModule, type IdentityFacade } from '../identity';
import { ORDERING_FACADE, OrderingModule, type OrderingFacade } from '../ordering';
import { WALLET_FACADE, WalletModule, type WalletFacade } from '../wallet';
import { ACCOUNT_DELETION_PEERS } from './application/ports/account-deletion-peers';
import type { LateBoundAccountDeletionPeers } from './infrastructure/late-bound-account-deletion-peers';
import { CustomersModule } from './customers.module';

/**
 * Binds the buyer deletion flow (customers package 5b) to the modules it asks. It is a module of
 * its own because `ordering` imports `customers`: `CustomersModule` provides the use cases, the
 * routes and the job with peers that refuse (fail closed) until this module binds the real
 * `ordering`, `wallet`, `identity` and `engagement` facades at start, and this module (which
 * imports all five) is registered beside them in `modules/index.ts`. It is not exported from the
 * customers entry point, so no file cycle forms.
 */
@Module({
  imports: [CustomersModule, IdentityModule, WalletModule, OrderingModule, EngagementModule],
})
export class CustomersAccountDeletionModule implements OnModuleInit {
  constructor(
    @Inject(ACCOUNT_DELETION_PEERS) private readonly peers: LateBoundAccountDeletionPeers,
    @Inject(IDENTITY_FACADE) private readonly identity: IdentityFacade,
    @Inject(WALLET_FACADE) private readonly wallet: WalletFacade,
    @Inject(ORDERING_FACADE) private readonly ordering: OrderingFacade,
    @Inject(ENGAGEMENT_FACADE) private readonly engagement: EngagementFacade,
  ) {}

  onModuleInit(): void {
    this.peers.bind({
      identity: this.identity,
      wallet: this.wallet,
      ordering: this.ordering,
      engagement: this.engagement,
    });
  }
}
