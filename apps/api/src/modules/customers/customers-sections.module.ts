import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import {
  AssistantModule,
  CUSTOMER_CONVERSATIONS_FACADE,
  type CustomerConversationsFacade,
} from '../assistant';
import { CART_ADMIN_FACADE, CartModule, type CartAdminFacade } from '../cart';
import {
  CUSTOMER_BEHAVIOUR_FACADE,
  EngagementModule,
  type CustomerBehaviourFacade,
} from '../engagement';
import { IDENTITY_FACADE, IdentityModule, type IdentityFacade } from '../identity';
import { CUSTOMER_CONSENT_FACADE, LegalModule, type CustomerConsentFacade } from '../legal';
import {
  CUSTOMER_REMINDERS_FACADE,
  NotificationsModule,
  type CustomerRemindersFacade,
} from '../notifications';
import { CUSTOMER_REVIEWS_FACADE, ReviewsModule, type CustomerReviewsFacade } from '../reviews';
import { CUSTOMER_SECTION_PEERS } from './application/ports/customer-section-peers';
import { RecordCustomerTimeline } from './application/use-cases/record-customer-timeline.use-case';
import { customerReviewTimelineSubscriptions } from './presentation/subscribers/customer-review-timeline.subscriptions';
import type { LateBoundSectionPeers } from './infrastructure/late-bound-section-peers';
import { CustomersModule } from './customers.module';

/**
 * Binds the customer page's sections (customers management phase 2b) to the modules that own
 * their data: identity, cart, notifications, engagement, legal, assistant and reviews (whose
 * events it also copies onto the author's timeline). A module of its own
 * because several owners reach `ordering`, which imports `customers`: `CustomersModule` provides
 * the section use cases with peers that refuse (fail closed) until this module binds the real
 * facades at start. Registered beside the other customers binding modules in `modules/index.ts`;
 * not exported from the customers entry point.
 */
@Module({
  imports: [
    CustomersModule,
    IdentityModule,
    CartModule,
    NotificationsModule,
    EngagementModule,
    LegalModule,
    AssistantModule,
    ReviewsModule,
  ],
  providers: [
    // Phase 2b, part 3: reviews' events onto the author's timeline (the author through reviews).
    registerSubscriptionsFrom(
      'customers',
      [RecordCustomerTimeline],
      (record: RecordCustomerTimeline) => customerReviewTimelineSubscriptions(record),
    ),
  ],
})
export class CustomersSectionsModule implements OnModuleInit {
  constructor(
    @Inject(CUSTOMER_SECTION_PEERS) private readonly peers: LateBoundSectionPeers,
    @Inject(IDENTITY_FACADE) private readonly identity: IdentityFacade,
    @Inject(CART_ADMIN_FACADE) private readonly cart: CartAdminFacade,
    @Inject(CUSTOMER_REMINDERS_FACADE) private readonly reminders: CustomerRemindersFacade,
    @Inject(CUSTOMER_BEHAVIOUR_FACADE) private readonly behaviour: CustomerBehaviourFacade,
    @Inject(CUSTOMER_CONSENT_FACADE) private readonly consent: CustomerConsentFacade,
    @Inject(CUSTOMER_CONVERSATIONS_FACADE)
    private readonly conversations: CustomerConversationsFacade,
    @Inject(CUSTOMER_REVIEWS_FACADE) private readonly reviews: CustomerReviewsFacade,
  ) {}

  onModuleInit(): void {
    this.peers.bind({
      identity: this.identity,
      cart: this.cart,
      reminders: this.reminders,
      behaviour: this.behaviour,
      consent: this.consent,
      conversations: this.conversations,
      reviews: this.reviews,
    });
  }
}
