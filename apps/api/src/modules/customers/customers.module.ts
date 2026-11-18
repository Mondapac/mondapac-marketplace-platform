import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import {
  registerPermissions,
  registerStepUpActions,
  STEP_UP_CONSUMER,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { SubjectRateLimits } from '../../platform/rate-limit/subject-rate-limits';
import { SECURITY_EVENTS } from '../../platform/security-events/security-events';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import type { AccountDeletionDependencies } from './application/account-deletion-dependencies';
import type { CustomersDependencies } from './application/customers-dependencies';
import {
  ACCOUNT_DELETION_PEERS,
  type AccountDeletionPeers,
} from './application/ports/account-deletion-peers';
import { ACCOUNT_DELETION_REQUEST_REPOSITORY } from './application/ports/account-deletion-request.repository';
import { AdminCancelAccountDeletion } from './application/use-cases/admin-cancel-account-deletion.use-case';
import { AdminListAccountDeletions } from './application/use-cases/admin-list-account-deletions.use-case';
import { AdminRequestAccountDeletion } from './application/use-cases/admin-request-account-deletion.use-case';
import { CancelAccountDeletion } from './application/use-cases/cancel-account-deletion.use-case';
import { ExecuteAccountDeletions } from './application/use-cases/execute-account-deletions.use-case';
import { RequestAccountDeletion } from './application/use-cases/request-account-deletion.use-case';
import { ViewAccountDeletionRequest } from './application/use-cases/view-account-deletion-request.use-case';
import { ACCOUNT_DELETION_SETTINGS_REPOSITORY } from './application/ports/account-deletion-settings.repository';
import {
  CUSTOMER_READ_MODEL_PEERS,
  type CustomerReadModelPeers,
} from './application/ports/customer-read-model-peers';
import { CUSTOMER_READ_MODEL_REPOSITORY } from './application/ports/customer-read-models.repository';
import type { ReadModelDependencies } from './application/read-model-dependencies';
import { ReadCustomerLastOrder } from './application/use-cases/read-customer-last-order.use-case';
import { ReadOwnLastOrder } from './application/use-cases/read-own-last-order.use-case';
import { ReconcileCustomerReadModels } from './application/use-cases/reconcile-customer-read-models.use-case';
import { SyncCustomerReadModel } from './application/use-cases/sync-customer-read-model.use-case';
import { CustomersReadFacadeImplementation } from './presentation/customers-read.facade';
import { ADDRESS_CIPHER } from './application/ports/address-cipher';
import { ADDRESS_POLICY } from './application/ports/address-policy';
import { ADMIN_ACTION_LIMITS } from './application/ports/admin-action-limits';
import { ADDRESS_REPOSITORY } from './application/ports/address.repository';
import { SetAccountDeletionSettings } from './application/use-cases/set-account-deletion-settings.use-case';
import { ViewAccountDeletionAvailability } from './application/use-cases/view-account-deletion-availability.use-case';
import { ViewAccountDeletionSettings } from './application/use-cases/view-account-deletion-settings.use-case';
import { CreateAddress } from './application/use-cases/create-address.use-case';
import { DeleteAddress } from './application/use-cases/delete-address.use-case';
import { ListAddresses } from './application/use-cases/list-addresses.use-case';
import { ReadDeliveryAddress } from './application/use-cases/read-delivery-address.use-case';
import { ReadOwnExclusiveSeller } from './application/use-cases/read-own-exclusive-seller.use-case';
import { SetDefaultAddress } from './application/use-cases/set-default-address.use-case';
import { UpdateAddress } from './application/use-cases/update-address.use-case';
import {
  CUSTOMERS_ACCOUNT_DELETION_FACADE,
  CUSTOMERS_CHECKOUT_FACADE,
  CUSTOMERS_PERMISSIONS,
  CUSTOMERS_READ_FACADE,
  CUSTOMERS_STEP_UP_ACTIONS,
  CUSTOMER_GROUP_USAGE_REGISTRY,
  CustomerGroupUsageRegistry,
} from './contracts';
import { AdminSellerAttributionsDecide } from './application/use-cases/admin-seller-attributions-decide.use-case';
import { AdminSellerAttributionsExport } from './application/use-cases/admin-seller-attributions-export.use-case';
import { AdminSellerAttributionsIds } from './application/use-cases/admin-seller-attributions-ids.use-case';
import { AdminSellerAttributionsList } from './application/use-cases/admin-seller-attributions-list.use-case';
import { JoinStoreByInvitation } from './application/use-cases/join-store-by-invitation.use-case';
import { ResolveStoreInvitation } from './application/use-cases/resolve-store-invitation.use-case';
import { SellerInviteLinkRefresh } from './application/use-cases/seller-invite-link-refresh.use-case';
import { SellerInviteLinkView } from './application/use-cases/seller-invite-link-view.use-case';
import { ViewOwnStoreInvitation } from './application/use-cases/view-own-store-invitation.use-case';
import {
  INVITATION_RULES,
  type InvitationDependencies,
} from './application/seller-invitations-flow';
import {
  INVITE_LINK_REPOSITORY,
  INVITE_TOKENS,
  SELLER_ATTRIBUTION_REPOSITORY,
} from './application/ports/seller-invitations.repository';
import { INVITATION_PEERS } from './application/ports/invitation-peers';
import { AdminSellerAttributionsController } from './presentation/admin-seller-attributions.controller';
import { SellerInviteLinkController } from './presentation/seller-invite-link.controller';
import {
  OwnStoreInvitationController,
  StoreInvitationController,
} from './presentation/store-invitation.controller';
import { CUSTOMERS_AUDIT_ACTIONS } from './domain/audit';
import { CUSTOMERS_EVENTS } from './domain/events';
import { customersProviders } from './infrastructure/customers-providers';
import { AccountDeletionRequestController } from './presentation/account-deletion-request.controller';
import { CustomersAccountDeletionFacadeImplementation } from './presentation/customers-account-deletion.facade';
import { executeAccountDeletionsJob } from './presentation/jobs/execute-account-deletions.job';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { AccountDeletionController } from './presentation/account-deletion.controller';
import { AdminAccountDeletionRequestsController } from './presentation/admin-account-deletion-requests.controller';
import { AdminAccountDeletionSettingsController } from './presentation/admin-account-deletion-settings.controller';
import { AddressBookController } from './presentation/address-book.controller';
import { CustomersCheckoutFacadeImplementation } from './presentation/customers-checkout.facade';
import { AdminCustomersController } from './presentation/admin-customers.controller';
import { CUSTOMER_LIST_READER } from './application/ports/customer-list.reader';
import { ADMIN_DAY_ZONE } from './application/ports/admin-day-zone';
import { SAVED_FILTER_REPOSITORY } from './application/ports/saved-filter.repository';
import { SHEET_WRITER } from './application/ports/sheet-writer';
import type { CustomerListDependencies } from './application/customer-list-flow';
import type { SavedViewDependencies } from './application/saved-views/saved-view-shared';
import type { AdminCustomersExportDependencies } from './application/use-cases/admin-customers-export.use-case';
import { AdminCustomerOverview } from './application/use-cases/admin-customer-overview.use-case';
import { AdminCustomerEmailChangeRequest } from './application/use-cases/admin-customer-email-change-request.use-case';
import { AdminCustomerEmailChangeCancel } from './application/use-cases/admin-customer-email-change-cancel.use-case';
import { CancelEmailChangeOnDeletion } from './application/use-cases/cancel-email-change-on-deletion.use-case';
import { AdminCustomerTabOpened } from './application/use-cases/admin-customer-tab-opened.use-case';
import type { CustomerPageDependencies } from './application/customer-page-flow';
import type { EmailChangeDependencies } from './application/admin-email-change-flow';
import { EMAIL_CHANGE_PEER, type EmailChangePeer } from './application/ports/email-change-peer';
import { AdminCustomersExport } from './application/use-cases/admin-customers-export.use-case';
import { AdminCustomersIds } from './application/use-cases/admin-customers-ids.use-case';
import { AdminCustomersList } from './application/use-cases/admin-customers-list.use-case';
import { AdminSavedFilterCreate } from './application/use-cases/admin-saved-filter-create.use-case';
import { AdminSavedFilterDelete } from './application/use-cases/admin-saved-filter-delete.use-case';
import { AdminSavedFilterUpdate } from './application/use-cases/admin-saved-filter-update.use-case';
import { AdminSavedFiltersList } from './application/use-cases/admin-saved-filters-list.use-case';
import { SavedFilterShareCheck } from './application/use-cases/saved-filter-share-check.use-case';
import { CustomerReviewEventsCheck } from './application/use-cases/customer-review-events-check.use-case';
import { CustomerConsentEventsCheck } from './application/use-cases/customer-consent-events-check.use-case';
import type { CustomerManagementDependencies } from './application/customer-management-dependencies';
import { CUSTOMER_GROUP_REPOSITORY } from './application/ports/customer-groups.repository';
import {
  CUSTOMER_MANAGEMENT_PEERS,
  type CustomerManagementPeers,
} from './application/ports/customer-management-peers';
import {
  CUSTOMER_NOTE_CIPHER,
  CUSTOMER_NOTE_REPOSITORY,
} from './application/ports/customer-notes.repository';
import { CUSTOMER_TIMELINE_REPOSITORY } from './application/ports/customer-timeline.repository';
import { AdminCustomerGroupCreate } from './application/use-cases/admin-customer-group-create.use-case';
import { AdminCustomerGroupMembersAdd } from './application/use-cases/admin-customer-group-members-add.use-case';
import { AdminCustomerGroupMembersRemove } from './application/use-cases/admin-customer-group-members-remove.use-case';
import { AdminCustomerGroupUpdate } from './application/use-cases/admin-customer-group-update.use-case';
import { AdminCustomerGroupView } from './application/use-cases/admin-customer-group-view.use-case';
import { AdminCustomerGroupsList } from './application/use-cases/admin-customer-groups-list.use-case';
import { AdminCustomerNoteAdd } from './application/use-cases/admin-customer-note-add.use-case';
import { AdminCustomerAddressReveal } from './application/use-cases/admin-customer-address-reveal.use-case';
import { AdminCustomerPasswordReset } from './application/use-cases/admin-customer-password-reset.use-case';
import { AdminCustomerSessions } from './application/use-cases/admin-customer-sessions.use-case';
import { AdminCustomerSignInReveal } from './application/use-cases/admin-customer-sign-in-reveal.use-case';
import { AdminCustomerSignInsExport } from './application/use-cases/admin-customer-sign-ins-export.use-case';
import { AdminCustomerSignIns } from './application/use-cases/admin-customer-sign-ins.use-case';
import { AdminCustomerSignOut } from './application/use-cases/admin-customer-sign-out.use-case';
import { AdminCustomerCartSection } from './application/use-cases/admin-customer-cart.use-case';
import { AdminCustomerSavedItemsSection } from './application/use-cases/admin-customer-saved-items.use-case';
import { AdminCustomerSavedItemsSectionExport } from './application/use-cases/admin-customer-saved-items-export.use-case';
import { AdminCustomerCartRemindersSection } from './application/use-cases/admin-customer-cart-reminders.use-case';
import { AdminCustomerCartRemindersSectionExport } from './application/use-cases/admin-customer-cart-reminders-export.use-case';
import { AdminCustomerCartAdditionsSection } from './application/use-cases/admin-customer-cart-additions.use-case';
import { AdminCustomerCartAdditionsSectionExport } from './application/use-cases/admin-customer-cart-additions-export.use-case';
import { AdminCustomerBehaviourSection } from './application/use-cases/admin-customer-behaviour.use-case';
import { AdminCustomerConsentSection } from './application/use-cases/admin-customer-consent.use-case';
import { AdminCustomerConsentHistorySection } from './application/use-cases/admin-customer-consent-history.use-case';
import { AdminCustomerConsentHistorySectionExport } from './application/use-cases/admin-customer-consent-history-export.use-case';
import { AdminCustomerAssistantConversationsSection } from './application/use-cases/admin-customer-assistant-conversations.use-case';
import { AdminCustomerAssistantConversationsSectionExport } from './application/use-cases/admin-customer-assistant-conversations-export.use-case';
import { AdminCustomerReviewsSection } from './application/use-cases/admin-customer-reviews.use-case';
import { AdminCustomerReviewsSectionExport } from './application/use-cases/admin-customer-reviews-export.use-case';
import { AdminCustomerSellerRatingsSection } from './application/use-cases/admin-customer-seller-ratings.use-case';
import { AdminCustomerSellerRatingsSectionExport } from './application/use-cases/admin-customer-seller-ratings-export.use-case';
import { AdminCustomerHelpfulVotesSection } from './application/use-cases/admin-customer-helpful-votes.use-case';
import { AdminCustomerHelpfulVotesSectionExport } from './application/use-cases/admin-customer-helpful-votes-export.use-case';
import { AdminCustomerReviewReportsSection } from './application/use-cases/admin-customer-review-reports.use-case';
import { AdminCustomerReviewReportsSectionExport } from './application/use-cases/admin-customer-review-reports-export.use-case';
import type { CustomerSectionDependencies } from './application/customer-section-lists';
import { CUSTOMER_SECTION_PEERS } from './application/ports/customer-section-peers';
import { LateBoundSectionPeers } from './infrastructure/late-bound-section-peers';
import { AdminCustomerActivityController } from './presentation/admin-customer-activity.controller';
import { AdminCustomerSectionsController } from './presentation/admin-customer-sections.controller';
import { AdminCustomerReviewsController } from './presentation/admin-customer-reviews.controller';
import { AdminCustomerAddresses } from './application/use-cases/admin-customer-addresses.use-case';
import { AdminCustomerNotesList } from './application/use-cases/admin-customer-notes-list.use-case';
import { AdminCustomerRename } from './application/use-cases/admin-customer-rename.use-case';
import { AdminCustomerTimelineExport } from './application/use-cases/admin-customer-timeline-export.use-case';
import { AdminCustomerTimeline } from './application/use-cases/admin-customer-timeline.use-case';
import {
  RecordCustomerTimeline,
  type TimelineRecordDependencies,
} from './application/use-cases/record-customer-timeline.use-case';
import { ReadCustomerGroupMembership } from './application/use-cases/read-customer-group-membership.use-case';
import { ReadExclusiveSeller } from './application/use-cases/read-exclusive-seller.use-case';
import { AdminCustomerManagementController } from './presentation/admin-customer-management.controller';
import type { SellerCustomerDependencies } from './application/seller-customers-flow';
import {
  CUSTOMER_CODES,
  SELLER_CUSTOMER_REPOSITORY,
  TREND_ZONES,
} from './application/ports/seller-customers.repository';
import { AdminSellerCustomersList } from './application/use-cases/admin-seller-customers-list.use-case';
import { AdminSellerCustomersSummary } from './application/use-cases/admin-seller-customers-summary.use-case';
import { ReconcileSellerCustomers } from './application/use-cases/reconcile-seller-customers.use-case';
import { SellerCustomerDetail } from './application/use-cases/seller-customer-detail.use-case';
import { SellerOrderCustomers } from './application/use-cases/seller-order-customers.use-case';
import { SellerCustomersCodes } from './application/use-cases/seller-customers-codes.use-case';
import { SellerCustomersExport } from './application/use-cases/seller-customers-export.use-case';
import { SellerCustomersList } from './application/use-cases/seller-customers-list.use-case';
import { SyncSellerCustomers } from './application/use-cases/sync-seller-customers.use-case';
import { AdminSellerCustomersController } from './presentation/admin-seller-customers.controller';
import { SellerCustomersController } from './presentation/seller-customers.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: CustomersDependencies) => U;

const PORTS: readonly [keyof CustomersDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['addresses', ADDRESS_REPOSITORY],
  ['cipher', ADDRESS_CIPHER],
  ['policy', ADDRESS_POLICY],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
  ['accountDeletionSettings', ACCOUNT_DELETION_SETTINGS_REPOSITORY],
  ['audit', AUDIT_WRITER],
  ['outbox', OUTBOX_WRITER],
  ['stepUp', STEP_UP_CONSUMER],
];

type DeletionUseCaseClass<U> = new (gate: UseCaseGate, deps: AccountDeletionDependencies) => U;

const DELETION_PORTS: readonly [keyof AccountDeletionDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['requests', ACCOUNT_DELETION_REQUEST_REPOSITORY],
  ['addresses', ADDRESS_REPOSITORY],
  ['readModels', CUSTOMER_READ_MODEL_REPOSITORY],
  ['accountDeletionSettings', ACCOUNT_DELETION_SETTINGS_REPOSITORY],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
  ['audit', AUDIT_WRITER],
  ['outbox', OUTBOX_WRITER],
  ['stepUp', STEP_UP_CONSUMER],
];

/** The deletion flow's use cases: the same ports, plus the peers bound at start. */
function deletionUseCaseProvider<U>(type: DeletionUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ACCOUNT_DELETION_PEERS, ...DELETION_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, peers: AccountDeletionPeers, ...values: unknown[]) =>
      new type(gate, {
        ...Object.fromEntries(DELETION_PORTS.map(([name], index) => [name, values[index]])),
        ...peers,
      } as unknown as AccountDeletionDependencies),
  };
}

type ReadModelUseCaseClass<U> = new (gate: UseCaseGate, deps: ReadModelDependencies) => U;

/** The read model use cases: their own ports, plus the peers bound at start. */
function readModelUseCaseProvider<U>(type: ReadModelUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      CUSTOMER_READ_MODEL_PEERS,
      UNIT_OF_WORK,
      CUSTOMER_READ_MODEL_REPOSITORY,
      CLOCK,
    ],
    useFactory: (
      gate: UseCaseGate,
      peers: CustomerReadModelPeers,
      unitOfWork: ReadModelDependencies['unitOfWork'],
      readModels: ReadModelDependencies['readModels'],
      clock: ReadModelDependencies['clock'],
    ) =>
      new type(gate, {
        identity: peers.identity,
        ordering: peers.ordering,
        unitOfWork,
        readModels,
        clock,
      }),
  };
}

type SellerCustomerUseCaseClass<U> = new (gate: UseCaseGate, deps: SellerCustomerDependencies) => U;

const SELLER_CUSTOMER_PORTS: readonly [
  Exclude<keyof SellerCustomerDependencies, 'identity' | 'ordering' | 'engagement'>,
  InjectionToken,
][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['sellerCustomers', SELLER_CUSTOMER_REPOSITORY],
  ['codes', CUSTOMER_CODES],
  ['readModels', CUSTOMER_READ_MODEL_REPOSITORY],
  ['clock', CLOCK],
  ['audit', AUDIT_WRITER],
  ['sheetWriter', SHEET_WRITER],
  ['zones', TREND_ZONES],
  ['attributions', SELLER_ATTRIBUTION_REPOSITORY],
];

/** The per-seller customers use cases (phase 3): their ports, plus the peers bound at start. */
function sellerCustomerUseCaseProvider<U>(type: SellerCustomerUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      CUSTOMER_READ_MODEL_PEERS,
      ...SELLER_CUSTOMER_PORTS.map(([, token]) => token),
    ],
    useFactory: (gate: UseCaseGate, peers: CustomerReadModelPeers, ...values: unknown[]) =>
      new type(gate, {
        ...Object.fromEntries(SELLER_CUSTOMER_PORTS.map(([name], index) => [name, values[index]])),
        identity: peers.identity,
        ordering: peers.ordering,
        engagement: peers.engagement,
      } as unknown as SellerCustomerDependencies),
  };
}

type InvitationUseCaseClass<U> = new (gate: UseCaseGate, deps: InvitationDependencies) => U;

const INVITATION_PORTS: readonly [keyof InvitationDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['inviteLinks', INVITE_LINK_REPOSITORY],
  ['attributions', SELLER_ATTRIBUTION_REPOSITORY],
  ['readModels', CUSTOMER_READ_MODEL_REPOSITORY],
  ['tokens', INVITE_TOKENS],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
  ['audit', AUDIT_WRITER],
  ['outbox', OUTBOX_WRITER],
  ['invitationPeers', INVITATION_PEERS],
  ['invitationRules', INVITATION_RULES],
  ['stepUp', STEP_UP_CONSUMER],
  ['sheetWriter', SHEET_WRITER],
  ['dayZone', ADMIN_DAY_ZONE],
];

/** The invite link and attribution use cases (phase 4a): their ports, with the peers bound at start. */
function invitationUseCaseProvider<U>(type: InvitationUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...INVITATION_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          INVITATION_PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as InvitationDependencies,
      ),
  };
}

type ListUseCaseClass<U> = new (gate: UseCaseGate, deps: CustomerListDependencies) => U;

/** The Customers list reads: the unit of work, the list reader and the clock. */
function listUseCaseProvider<U>(type: ListUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      UNIT_OF_WORK,
      CUSTOMER_LIST_READER,
      CLOCK,
      ADMIN_DAY_ZONE,
      CUSTOMER_MANAGEMENT_PEERS,
    ],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: CustomerListDependencies['unitOfWork'],
      listReader: CustomerListDependencies['listReader'],
      clock: CustomerListDependencies['clock'],
      dayZone: CustomerListDependencies['dayZone'],
      peers: CustomerManagementPeers,
    ) => new type(gate, { unitOfWork, listReader, clock, dayZone, orders: peers.ordering }),
  };
}

type PageUseCaseClass<U> = new (gate: UseCaseGate, deps: CustomerPageDependencies) => U;

/** The customer page use cases: the list reads, the audit writer and the open deletion request. */
function pageUseCaseProvider<U>(type: PageUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      UNIT_OF_WORK,
      CUSTOMER_LIST_READER,
      CLOCK,
      AUDIT_WRITER,
      ACCOUNT_DELETION_REQUEST_REPOSITORY,
      CUSTOMER_TIMELINE_REPOSITORY,
      ID_GENERATOR,
      ADMIN_DAY_ZONE,
      ACCOUNT_DELETION_REQUEST_REPOSITORY,
      CUSTOMER_MANAGEMENT_PEERS,
      EMAIL_CHANGE_PEER,
    ],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: CustomerPageDependencies['unitOfWork'],
      listReader: CustomerPageDependencies['listReader'],
      clock: CustomerPageDependencies['clock'],
      audit: CustomerPageDependencies['audit'],
      deletionRequests: CustomerPageDependencies['deletionRequests'],
      timeline: CustomerPageDependencies['timeline'],
      ids: CustomerPageDependencies['ids'],
      dayZone: CustomerPageDependencies['dayZone'],
      deletions: CustomerPageDependencies['deletions'],
      peers: CustomerManagementPeers,
      emailChanges: EmailChangePeer,
    ) =>
      new type(gate, {
        unitOfWork,
        listReader,
        clock,
        audit,
        deletionRequests,
        timeline,
        ids,
        dayZone,
        deletions,
        orders: peers.ordering,
        pendingEmails: emailChanges,
      }),
  };
}

type SavedViewUseCaseClass<U> = new (gate: UseCaseGate, deps: SavedViewDependencies) => U;

/** The saved-filter use cases: their own, smaller dependency set. */
function savedViewProvider<U>(type: SavedViewUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      UNIT_OF_WORK,
      SAVED_FILTER_REPOSITORY,
      AUDIT_WRITER,
      CLOCK,
      ID_GENERATOR,
      SavedFilterShareCheck,
    ],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: SavedViewDependencies['unitOfWork'],
      savedFilters: SavedViewDependencies['savedFilters'],
      audit: SavedViewDependencies['audit'],
      clock: SavedViewDependencies['clock'],
      ids: SavedViewDependencies['ids'],
      shareCheck: SavedFilterShareCheck,
    ) => new type(gate, { unitOfWork, savedFilters, audit, clock, ids, shareCheck }),
  };
}

type ManagementUseCaseClass<U> = new (gate: UseCaseGate, deps: CustomerManagementDependencies) => U;

const MANAGEMENT_PORTS: readonly [
  Exclude<keyof CustomerManagementDependencies, 'identity'>,
  InjectionToken,
][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['groups', CUSTOMER_GROUP_REPOSITORY],
  ['notes', CUSTOMER_NOTE_REPOSITORY],
  ['noteCipher', CUSTOMER_NOTE_CIPHER],
  ['timeline', CUSTOMER_TIMELINE_REPOSITORY],
  ['listReader', CUSTOMER_LIST_READER],
  ['audit', AUDIT_WRITER],
  ['clock', CLOCK],
  ['ids', ID_GENERATOR],
  ['stepUp', STEP_UP_CONSUMER],
  ['sheetWriter', SHEET_WRITER],
  ['dayZone', ADMIN_DAY_ZONE],
  ['addresses', ADDRESS_REPOSITORY],
  ['addressCipher', ADDRESS_CIPHER],
  ['groupUsage', CUSTOMER_GROUP_USAGE_REGISTRY],
  ['reviewEventsCheck', CustomerReviewEventsCheck],
  ['consentEventsCheck', CustomerConsentEventsCheck],
  ['adminLimits', ADMIN_ACTION_LIMITS],
  ['securityEvents', SECURITY_EVENTS],
];

/** The admin's management of customers (phase 2): its ports, plus identity bound at start. */
function managementUseCaseProvider<U>(type: ManagementUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      CUSTOMER_MANAGEMENT_PEERS,
      ...MANAGEMENT_PORTS.map(([, token]) => token),
    ],
    useFactory: (gate: UseCaseGate, peers: CustomerManagementPeers, ...values: unknown[]) =>
      new type(gate, {
        ...Object.fromEntries(MANAGEMENT_PORTS.map(([name], index) => [name, values[index]])),
        identity: peers.identity,
      } as unknown as CustomerManagementDependencies),
  };
}

type SectionUseCaseClass<U> = new (gate: UseCaseGate, deps: CustomerSectionDependencies) => U;

const SECTION_PORTS: readonly [
  Exclude<keyof CustomerSectionDependencies, 'peers'>,
  InjectionToken,
][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['listReader', CUSTOMER_LIST_READER],
  ['timeline', CUSTOMER_TIMELINE_REPOSITORY],
  ['audit', AUDIT_WRITER],
  ['stepUp', STEP_UP_CONSUMER],
  ['sheetWriter', SHEET_WRITER],
  ['clock', CLOCK],
  ['ids', ID_GENERATOR],
  ['adminLimits', ADMIN_ACTION_LIMITS],
  ['securityEvents', SECURITY_EVENTS],
];

/** The customer page's sections other modules own (phase 2b): its ports, plus the owners bound at start. */
function sectionUseCaseProvider<U>(type: SectionUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, CUSTOMER_SECTION_PEERS, ...SECTION_PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, peers: LateBoundSectionPeers, ...values: unknown[]) =>
      new type(gate, {
        ...Object.fromEntries(SECTION_PORTS.map(([name], index) => [name, values[index]])),
        peers,
      } as unknown as CustomerSectionDependencies),
  };
}

/** Every customers use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as CustomersDependencies,
      ),
  };
}

/**
 * Customers: the buyer's own data beside the `identity` account (customers package 1: the
 * delivery address book). A signed-in customer keeps up to the Market's limit of addresses, one of
 * them the default; each address is sealed under the account's subject key. No permission key:
 * every buyer use case is the customer's own (`own-resources`); the setting has a plain view key
 * and a protected manage key. Package 2: checkout reads the chosen
 * address through `CUSTOMERS_CHECKOUT_FACADE` and copies it onto the order. Package 5a: the
 * Market's account deletion setting (an admin switches buyer deletion on and sets its waiting
 * period; each change is an insert-only version, an audit row and an outbox event) and the
 * customer's read of it.
 */
@Module({
  controllers: [
    AddressBookController,
    AccountDeletionController,
    AccountDeletionRequestController,
    AdminAccountDeletionSettingsController,
    AdminAccountDeletionRequestsController,
    AdminCustomersController,
    AdminCustomerManagementController,
    AdminCustomerSectionsController,
    AdminCustomerActivityController,
    AdminCustomerReviewsController,
    SellerCustomersController,
    AdminSellerCustomersController,
    SellerInviteLinkController,
    StoreInvitationController,
    OwnStoreInvitationController,
    AdminSellerAttributionsController,
  ],
  providers: [
    {
      provide: CUSTOMER_GROUP_USAGE_REGISTRY,
      // A factory, not a value: each application (and each test app) gets its own registry.
      useFactory: () => new CustomerGroupUsageRegistry(),
    },
    PersistenceModule.auditWriterFor('customers'),
    PersistenceModule.outboxWriterFor('customers'),
    PersistenceModule.securityEventsFor('customers'),
    SubjectRateLimits,
    registerAuditActions('customers', CUSTOMERS_AUDIT_ACTIONS),
    registerEvents('customers', CUSTOMERS_EVENTS),
    registerPermissions('customers', CUSTOMERS_PERMISSIONS),
    registerStepUpActions('customers', CUSTOMERS_STEP_UP_ACTIONS),
    ...customersProviders,
    ...[
      ListAddresses,
      CreateAddress,
      UpdateAddress,
      DeleteAddress,
      SetDefaultAddress,
      ReadDeliveryAddress,
      ViewAccountDeletionSettings,
      SetAccountDeletionSettings,
      ViewAccountDeletionAvailability,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    ...[
      RequestAccountDeletion,
      ViewAccountDeletionRequest,
      CancelAccountDeletion,
      ExecuteAccountDeletions,
      AdminRequestAccountDeletion,
      AdminCancelAccountDeletion,
      AdminListAccountDeletions,
    ].map((type) => deletionUseCaseProvider(type as DeletionUseCaseClass<unknown>)),
    ...[
      SyncCustomerReadModel,
      ReconcileCustomerReadModels,
      ReadCustomerLastOrder,
      ReadOwnLastOrder,
    ].map((type) => readModelUseCaseProvider(type as ReadModelUseCaseClass<unknown>)),
    ...[
      SyncSellerCustomers,
      ReconcileSellerCustomers,
      SellerCustomersList,
      SellerCustomersCodes,
      SellerCustomersExport,
      SellerCustomerDetail,
      SellerOrderCustomers,
      AdminSellerCustomersList,
      AdminSellerCustomersSummary,
    ].map((type) => sellerCustomerUseCaseProvider(type as SellerCustomerUseCaseClass<unknown>)),
    ...[
      SellerInviteLinkView,
      ReadExclusiveSeller,
      ReadOwnExclusiveSeller,
      SellerInviteLinkRefresh,
      ResolveStoreInvitation,
      JoinStoreByInvitation,
      ViewOwnStoreInvitation,
      AdminSellerAttributionsList,
      AdminSellerAttributionsIds,
      AdminSellerAttributionsExport,
      AdminSellerAttributionsDecide,
    ].map((type) => invitationUseCaseProvider(type as InvitationUseCaseClass<unknown>)),
    // The overview also reads the pending email change from identity (admin email change).
    ...[AdminCustomerOverview, AdminCustomerTabOpened].map((type) =>
      pageUseCaseProvider(type as PageUseCaseClass<unknown>),
    ),
    ...[AdminCustomerEmailChangeRequest, AdminCustomerEmailChangeCancel].map(
      (type): FactoryProvider => ({
        provide: type,
        inject: [
          USE_CASE_GATE,
          UNIT_OF_WORK,
          ACCOUNT_DELETION_REQUEST_REPOSITORY,
          EMAIL_CHANGE_PEER,
        ],
        useFactory: (
          gate: UseCaseGate,
          unitOfWork: EmailChangeDependencies['unitOfWork'],
          requests: EmailChangeDependencies['requests'],
          identity: EmailChangePeer,
        ) => new type(gate, { unitOfWork, requests, identity }),
      }),
    ),
    {
      provide: CancelEmailChangeOnDeletion,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, ACCOUNT_DELETION_REQUEST_REPOSITORY, EMAIL_CHANGE_PEER],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: EmailChangeDependencies['unitOfWork'],
        requests: EmailChangeDependencies['requests'],
        identity: EmailChangePeer,
      ) => new CancelEmailChangeOnDeletion(gate, { unitOfWork, requests, identity }),
    },
    ...[
      AdminCustomerGroupsList,
      AdminCustomerGroupView,
      AdminCustomerGroupCreate,
      AdminCustomerGroupUpdate,
      AdminCustomerGroupMembersAdd,
      AdminCustomerGroupMembersRemove,
      AdminCustomerNotesList,
      AdminCustomerNoteAdd,
      AdminCustomerTimeline,
      AdminCustomerTimelineExport,
      AdminCustomerRename,
      AdminCustomerAddresses,
      AdminCustomerAddressReveal,
    ].map((type) => managementUseCaseProvider(type as ManagementUseCaseClass<unknown>)),
    // Phase 2b: the sections other modules own, bound to them by CustomersSectionsModule.
    { provide: CUSTOMER_SECTION_PEERS, useFactory: () => new LateBoundSectionPeers() },
    ...[
      AdminCustomerSignIns,
      AdminCustomerSignInsExport,
      AdminCustomerSignInReveal,
      AdminCustomerSessions,
      AdminCustomerSignOut,
      AdminCustomerPasswordReset,
      AdminCustomerCartSection,
      AdminCustomerSavedItemsSection,
      AdminCustomerSavedItemsSectionExport,
      AdminCustomerCartRemindersSection,
      AdminCustomerCartRemindersSectionExport,
      AdminCustomerCartAdditionsSection,
      AdminCustomerCartAdditionsSectionExport,
      AdminCustomerBehaviourSection,
      AdminCustomerConsentSection,
      AdminCustomerConsentHistorySection,
      AdminCustomerConsentHistorySectionExport,
      AdminCustomerAssistantConversationsSection,
      AdminCustomerAssistantConversationsSectionExport,
      // Part 3: the reviews sections.
      AdminCustomerReviewsSection,
      AdminCustomerReviewsSectionExport,
      AdminCustomerSellerRatingsSection,
      AdminCustomerSellerRatingsSectionExport,
      AdminCustomerHelpfulVotesSection,
      AdminCustomerHelpfulVotesSectionExport,
      AdminCustomerReviewReportsSection,
      AdminCustomerReviewReportsSectionExport,
    ].map((type) => sectionUseCaseProvider(type as SectionUseCaseClass<unknown>)),
    {
      provide: RecordCustomerTimeline,
      inject: [
        USE_CASE_GATE,
        CUSTOMER_READ_MODEL_PEERS,
        CUSTOMER_SECTION_PEERS,
        UNIT_OF_WORK,
        CUSTOMER_TIMELINE_REPOSITORY,
        ID_GENERATOR,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        peers: CustomerReadModelPeers,
        sections: LateBoundSectionPeers,
        unitOfWork: TimelineRecordDependencies['unitOfWork'],
        timeline: TimelineRecordDependencies['timeline'],
        ids: TimelineRecordDependencies['ids'],
        clock: TimelineRecordDependencies['clock'],
      ) =>
        new RecordCustomerTimeline(gate, {
          identity: peers.identity,
          ordering: peers.ordering,
          reviews: sections.reviews,
          unitOfWork,
          timeline,
          ids,
          clock,
        }),
    },
    {
      provide: ReadCustomerGroupMembership,
      inject: [USE_CASE_GATE, UNIT_OF_WORK, CUSTOMER_GROUP_REPOSITORY],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: CustomerManagementDependencies['unitOfWork'],
        groups: CustomerManagementDependencies['groups'],
      ) => new ReadCustomerGroupMembership(gate, { unitOfWork, groups }),
    },
    ...[AdminCustomersList, AdminCustomersIds].map((type) =>
      listUseCaseProvider(type as ListUseCaseClass<unknown>),
    ),
    {
      provide: AdminCustomersExport,
      inject: [
        USE_CASE_GATE,
        UNIT_OF_WORK,
        CUSTOMER_LIST_READER,
        SHEET_WRITER,
        AUDIT_WRITER,
        STEP_UP_CONSUMER,
        CLOCK,
        ADMIN_DAY_ZONE,
      ],
      useFactory: (
        gate: UseCaseGate,
        unitOfWork: AdminCustomersExportDependencies['unitOfWork'],
        listReader: AdminCustomersExportDependencies['listReader'],
        sheetWriter: AdminCustomersExportDependencies['sheetWriter'],
        audit: AdminCustomersExportDependencies['audit'],
        stepUp: AdminCustomersExportDependencies['stepUp'],
        clock: AdminCustomersExportDependencies['clock'],
        dayZone: AdminCustomersExportDependencies['dayZone'],
      ) =>
        new AdminCustomersExport(gate, {
          unitOfWork,
          listReader,
          sheetWriter,
          audit,
          stepUp,
          clock,
          dayZone,
        }),
    },
    {
      provide: SavedFilterShareCheck,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate): SavedFilterShareCheck => new SavedFilterShareCheck(gate),
    },
    {
      provide: CustomerReviewEventsCheck,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate): CustomerReviewEventsCheck =>
        new CustomerReviewEventsCheck(gate),
    },
    {
      provide: CustomerConsentEventsCheck,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate): CustomerConsentEventsCheck =>
        new CustomerConsentEventsCheck(gate),
    },
    ...[
      AdminSavedFiltersList,
      AdminSavedFilterCreate,
      AdminSavedFilterUpdate,
      AdminSavedFilterDelete,
    ].map((type) => savedViewProvider(type as SavedViewUseCaseClass<unknown>)),
    {
      provide: CUSTOMERS_READ_FACADE,
      inject: [
        ReadCustomerLastOrder,
        ReadOwnLastOrder,
        ReadCustomerGroupMembership,
        ReadExclusiveSeller,
        SellerOrderCustomers,
      ],
      useFactory: (
        read: ReadCustomerLastOrder,
        own: ReadOwnLastOrder,
        membership: ReadCustomerGroupMembership,
        exclusive: ReadExclusiveSeller,
        orderCustomers: SellerOrderCustomers,
      ) => new CustomersReadFacadeImplementation(read, own, membership, exclusive, orderCustomers),
    },
    {
      provide: CUSTOMERS_ACCOUNT_DELETION_FACADE,
      inject: [CancelAccountDeletion],
      useFactory: (cancel: CancelAccountDeletion) =>
        new CustomersAccountDeletionFacadeImplementation(cancel),
    },
    registerJobsFrom('customers', [ExecuteAccountDeletions], (execute: ExecuteAccountDeletions) => [
      executeAccountDeletionsJob(execute),
    ]),
    {
      provide: CUSTOMERS_CHECKOUT_FACADE,
      inject: [ReadDeliveryAddress, ReadOwnExclusiveSeller],
      useFactory: (read: ReadDeliveryAddress, exclusive: ReadOwnExclusiveSeller) =>
        new CustomersCheckoutFacadeImplementation(read, exclusive),
    },
  ],
  exports: [
    CUSTOMERS_CHECKOUT_FACADE,
    CUSTOMERS_ACCOUNT_DELETION_FACADE,
    CUSTOMERS_READ_FACADE,
    ACCOUNT_DELETION_PEERS,
    EMAIL_CHANGE_PEER,
    CUSTOMER_READ_MODEL_PEERS,
    SyncCustomerReadModel,
    ReconcileCustomerReadModels,
    CUSTOMER_MANAGEMENT_PEERS,
    INVITATION_PEERS,
    RecordCustomerTimeline,
    CancelEmailChangeOnDeletion,
    CUSTOMER_GROUP_USAGE_REGISTRY,
    CUSTOMER_SECTION_PEERS,
    SyncSellerCustomers,
    ReconcileSellerCustomers,
  ],
})
export class CustomersModule {}
