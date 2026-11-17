import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { ENGAGEMENT_FACADE, EngagementModule, type EngagementFacade } from '../engagement';
import { IDENTITY_FACADE, IdentityModule, type IdentityFacade } from '../identity';
import { ORDERING_FACADE, OrderingModule, type OrderingFacade } from '../ordering';
import { SELLERS_FACADE, SellersModule, type SellersFacade } from '../sellers';
import { INVITATION_PEERS } from './application/ports/invitation-peers';
import type { LateBoundInvitationPeers } from './infrastructure/late-bound-invitation-peers';
import { CUSTOMER_READ_MODEL_PEERS } from './application/ports/customer-read-model-peers';
import { ReconcileCustomerReadModels } from './application/use-cases/reconcile-customer-read-models.use-case';
import { SyncCustomerReadModel } from './application/use-cases/sync-customer-read-model.use-case';
import { RecordCustomerTimeline } from './application/use-cases/record-customer-timeline.use-case';
import { CUSTOMER_MANAGEMENT_PEERS } from './application/ports/customer-management-peers';
import type { LateBoundManagementPeers } from './infrastructure/late-bound-management-peers';
import { customerTimelineSubscriptions } from './presentation/subscribers/customer-timeline.subscriptions';
import { ReconcileSellerCustomers } from './application/use-cases/reconcile-seller-customers.use-case';
import { SyncSellerCustomers } from './application/use-cases/sync-seller-customers.use-case';
import { reconcileSellerCustomersJob } from './presentation/jobs/reconcile-seller-customers.job';
import { sellerCustomersSubscriptions } from './presentation/subscribers/seller-customers.subscriptions';
import type { LateBoundReadModelPeers } from './infrastructure/late-bound-read-model-peers';
import { CustomersModule } from './customers.module';
import { reconcileReadModelsJob } from './presentation/jobs/reconcile-read-models.job';
import { customerReadModelSubscriptions } from './presentation/subscribers/customer-read-model.subscriptions';

/**
 * Binds the customers read models (phase 1, package B1; the per-seller customers of phase 3) to
 * `identity`, `ordering` and `engagement`, and the invite links (phase 4a) to `identity`,
 * `engagement` and `sellers`. It is a
 * module of its own because `ordering` imports `customers`: `CustomersModule` provides the use
 * cases with peers that refuse (fail closed) until this module binds the real facades at start,
 * and this module also holds what needs the other modules' event definitions (the subscriptions
 * on identity's account events and ordering's order and refund events) and the reconcile job.
 * Registered beside `CustomersAccountDeletionModule` in `modules/index.ts`; not exported from the
 * customers entry point, so no file cycle forms.
 */
@Module({
  imports: [CustomersModule, IdentityModule, OrderingModule, EngagementModule, SellersModule],
  providers: [
    registerSubscriptionsFrom(
      'customers',
      [SyncCustomerReadModel, RecordCustomerTimeline],
      (sync: SyncCustomerReadModel, record: RecordCustomerTimeline) => [
        ...customerReadModelSubscriptions(sync),
        ...customerTimelineSubscriptions(record),
      ],
    ),
    registerSubscriptionsFrom('customers', [SyncSellerCustomers], (sync: SyncSellerCustomers) =>
      sellerCustomersSubscriptions(sync),
    ),
    registerJobsFrom(
      'customers',
      [ReconcileCustomerReadModels, ReconcileSellerCustomers],
      (reconcile: ReconcileCustomerReadModels, sellers: ReconcileSellerCustomers) => [
        reconcileReadModelsJob(reconcile),
        reconcileSellerCustomersJob(sellers),
      ],
    ),
  ],
})
export class CustomersReadModelsModule implements OnModuleInit {
  constructor(
    @Inject(CUSTOMER_READ_MODEL_PEERS) private readonly peers: LateBoundReadModelPeers,
    @Inject(CUSTOMER_MANAGEMENT_PEERS) private readonly management: LateBoundManagementPeers,
    @Inject(IDENTITY_FACADE) private readonly identity: IdentityFacade,
    @Inject(ORDERING_FACADE) private readonly ordering: OrderingFacade,
    @Inject(ENGAGEMENT_FACADE) private readonly engagement: EngagementFacade,
    @Inject(INVITATION_PEERS) private readonly invitations: LateBoundInvitationPeers,
    @Inject(SELLERS_FACADE) private readonly sellers: SellersFacade,
  ) {}

  onModuleInit(): void {
    this.peers.bind({
      identity: this.identity,
      ordering: this.ordering,
      engagement: this.engagement,
    });
    this.management.bind({ identity: this.identity });
    this.invitations.bind({
      identity: this.identity,
      engagement: this.engagement,
      sellers: this.sellers,
    });
  }
}
