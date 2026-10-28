import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import {
  AUTHORISATION_CHECK,
  registerPermissions,
  registerStepUpActions,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { AUDIT_TRAIL_READER } from '../../platform/audit/audit-trail-reader';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { registerEvents } from '../../platform/events/event-catalogue';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { IdentityModule } from '../identity';
import { BUSINESS_FILE_REVISION_REPOSITORY } from './application/ports/business-file-revision.repository';
import { REVIEWER_NOTIFIER } from './application/ports/reviewer-notifier';
import { REVISION_CONTENT_SEALER } from './application/ports/revision-content-sealer';
import { SELLER_ACCESS_READER } from './application/ports/seller-access-reader';
import { SELLER_ACCOUNT_DIRECTORY } from './application/ports/seller-account-directory';
import { TEAM_MEMBER_LABEL_SOURCE } from './application/ports/team-member-labels';
import { BUSINESS_IDENTIFIER_SCHEMES } from './application/ports/business-identifier-scheme';
import { BUSINESS_REGISTER_LOOKUPS } from './application/ports/business-register-lookup';
import { IDENTIFIER_INDEX } from './application/ports/identifier-index';
import { LOCATION_TIMEZONE_RESOLVER } from './application/ports/location-timezone-resolver';
import { RATE_COUNTER_KEYS } from './application/ports/rate-counter-keys';
import { RATE_COUNTER_REPOSITORY } from './application/ports/rate-counter.repository';
import { REGISTER_CHECK_REPOSITORY } from './application/ports/register-check.repository';
import { REGISTER_LOOKUP_POLICY } from './application/ports/register-lookup-policy';
import { REGISTERED_SELLER_SOURCE } from './application/ports/registered-seller-source';
import { SELLER_FILE_CIPHER } from './application/ports/seller-file-cipher';
import { SELLER_LIST_REPOSITORY } from './application/ports/seller-list.repository';
import { SELLER_FILE_REPOSITORY } from './application/ports/seller-file.repository';
import {
  ADDRESS_FORMATS,
  ONBOARDING_AREAS,
  SERVICE_AREAS,
  TIMEZONE_RESOLVER,
} from './application/ports/seller-market-formats';
import { SELLER_MARKET_POLICY } from './application/ports/seller-market-policy';
import { SHOP_SLUG_REPOSITORY } from './application/ports/shop-slug.repository';
import { TAX_PROFILE_REPOSITORY } from './application/ports/tax-profile.repository';
import { ADMIN_FLAG_REPOSITORY } from './application/ports/admin-flag.repository';
import { SELLING_FACTS_REPOSITORY } from './application/ports/selling-facts.repository';
import { MINIMUM_ORDER_POLICY } from './application/ports/minimum-order-policy';
import { STORE_PROFILE_REPOSITORY } from './application/ports/store-profile.repository';
import { IDENTIFIER_CLAIM_REPOSITORY } from './application/ports/identifier-claim.repository';
import { REVIEW_CHECK_REPOSITORY } from './application/ports/review-check.repository';
import { SELLER_ACCESS_DECIDER } from './application/ports/seller-access-decider';
import { CloseDecision } from './application/use-cases/close-decision.use-case';
import { ReconcileDecisions } from './application/use-cases/reconcile-decisions.use-case';
import { ReviewApprove } from './application/use-cases/review-approve.use-case';
import { ReviewReject } from './application/use-cases/review-reject.use-case';
import { ReviewRecordManualCheck } from './application/use-cases/review-record-manual-check.use-case';
import { AfterSubmission } from './application/use-cases/after-submission.use-case';
import { MyFileSubmit } from './application/use-cases/my-file-submit.use-case';
import { MyFileWithdraw } from './application/use-cases/my-file-withdraw.use-case';
import { ApprovedSellerZonesSystem } from './application/use-cases/approved-seller-zones-system.use-case';
import { ApprovedSellerZones } from './application/use-cases/approved-seller-zones.use-case';
import { BackfillSellerFiles } from './application/use-cases/backfill-seller-files.use-case';
import { CreateSellerFile } from './application/use-cases/create-seller-file.use-case';
import { FormDescriptorsRead } from './application/use-cases/form-descriptors-read.use-case';
import { MyFileCheckSlug } from './application/use-cases/my-file-check-slug.use-case';
import { MyFileRead } from './application/use-cases/my-file-read.use-case';
import { MyFileSaveAddress } from './application/use-cases/my-file-save-address.use-case';
import { MyFileSaveIdentifier } from './application/use-cases/my-file-save-identifier.use-case';
import { MyFileSaveSlug } from './application/use-cases/my-file-save-slug.use-case';
import { MyFileValidateIdentifier } from './application/use-cases/my-file-validate-identifier.use-case';
import { MyFileSaveGeneral } from './application/use-cases/my-file-save-general.use-case';
import { CarrierPickupRead } from './application/use-cases/carrier-pickup.use-case';
import { OperatingZones } from './application/use-cases/operating-zones.use-case';
import { PickupPostcodes } from './application/use-cases/pickup-postcodes.use-case';
import { ReviewerBusinessDetailsRead } from './application/use-cases/reviewer-business-details.use-case';
import { ReviewRead } from './application/use-cases/review-read.use-case';
import { ReviewRegisterCheckRead } from './application/use-cases/review-register-check-read.use-case';
import { PurgeExpired } from './application/use-cases/purge-expired.use-case';
import { SellerList } from './application/use-cases/list.use-case';
import { SellerSummariesSystem } from './application/use-cases/seller-summaries-system.use-case';
import { SellerSummaries } from './application/use-cases/seller-summaries.use-case';
import { ActiveSinceSystem } from './application/use-cases/active-since-system.use-case';
import { ActiveSince } from './application/use-cases/active-since.use-case';
import { BlogAccessSystem } from './application/use-cases/blog-access-system.use-case';
import { BlogAccess } from './application/use-cases/blog-access.use-case';
import { BlogAccessSetUseCase } from './application/use-cases/blog-access-set.use-case';
import { BlogAccessController } from './presentation/blog-access.controller';
import { BLOG_ACCESS_REPOSITORY } from './application/ports/blog-access.repository';
import { AllowedProductTypesSystem } from './application/use-cases/allowed-product-types-system.use-case';
import { AllowedProductTypes } from './application/use-cases/allowed-product-types.use-case';
import { SellingEligibilitySystem } from './application/use-cases/selling-eligibility-system.use-case';
import { SellingEligibility } from './application/use-cases/selling-eligibility.use-case';
import { SELLERS_PERMISSIONS } from './contracts/permissions';
import { SELLERS_STEP_UP_ACTIONS } from './contracts/step-up';
import { APPROVED_SELLER_ZONES } from './contracts/approved-seller-zones.contract';
import { SELLERS_FACADE } from './contracts/sellers.facade';
import { SELLERS_AUDIT_ACTIONS } from './domain/audit';
import { OwnZoneRead } from './application/use-cases/own-zone-read.use-case';
import { StoreSettingsMinimumOrderHistory } from './application/use-cases/store-settings-minimum-order-history.use-case';
import { StoreSettingsRead } from './application/use-cases/store-settings-read.use-case';
import { StoreSettingsSaveDelivery } from './application/use-cases/store-settings-save-delivery.use-case';
import { StoreSettingsSaveMinimumOrder } from './application/use-cases/store-settings-save-minimum-order.use-case';
import { OwnZoneController } from './presentation/own-zone.controller';
import { StoreSettingsController } from './presentation/store-settings.controller';
import { SELLERS_EVENTS } from './domain/events';
import { sellerProviders } from './infrastructure/seller-providers';
import { purgeExpiredJob } from './presentation/jobs/purge-expired.job';
import { reconcileDecisionsJob } from './presentation/jobs/reconcile-decisions.job';
import { ReviewDecisionController } from './presentation/review-decision.controller';
import { decisionSubscriptions } from './presentation/subscribers/decision.subscriptions';
import { backfillSellerFilesJob } from './presentation/jobs/backfill-seller-files.job';
import { ApprovedSellerZonesReaderImplementation } from './presentation/approved-seller-zones.reader';
import { SellersFacadeImplementation } from './presentation/sellers.facade';
import { MyFileController } from './presentation/my-file.controller';
import { ReviewReadController } from './presentation/review-read.controller';
import { ReviewRegisterCheckController } from './presentation/review-register-check.controller';
import { SellerListController } from './presentation/seller-list.controller';
import { PublicStoreController } from './presentation/public-store.controller';
import { PublishedStoreList } from './application/use-cases/published-store-list.use-case';
import { PublishedStoreRead } from './application/use-cases/published-store-read.use-case';
import { PublishedStoreSellerId } from './application/use-cases/published-store-seller-id.use-case';
import { PublishedStoreSlugs } from './application/use-cases/published-store-slugs.use-case';
import { PUBLISHED_STORE_REPOSITORY } from './application/ports/published-store.repository';
import { OBJECT_STORE } from '../../platform/storage/object-store';
import { STORE_IMAGE_PROCESSOR } from './application/ports/store-image-processor';
import { STORE_IMAGE_REPOSITORY } from './application/ports/store-image.repository';
import { STORE_PROFILE_CONTENT_SEALER } from './application/ports/store-profile-content-sealer';
import { STORE_PROFILE_CONTENT_REPOSITORY } from './application/ports/store-profile-content.repository';
import { STORE_PROFILE_LOCALES_POLICY } from './application/ports/store-profile-locales';
import { STORE_TEXT_CLAIM_CHECK } from './application/ports/store-text-claim-check';
import { PUBLISHED_STORE_CONTENT } from './application/store-profile/published-store-content';
import { PublishedStoreImageRead } from './application/use-cases/published-store-image-read.use-case';
import { StoreImageReadOwn } from './application/use-cases/store-image-read-own.use-case';
import { StoreImageRemove } from './application/use-cases/store-image-remove.use-case';
import { StoreImageSave } from './application/use-cases/store-image-save.use-case';
import { StoreProfileRead } from './application/use-cases/store-profile-read.use-case';
import { StoreProfileSaveAbout } from './application/use-cases/store-profile-save-about.use-case';
import { storeProfileProviders } from './infrastructure/store-profile-providers';
import { PublicStoreImageController } from './presentation/public-store-image.controller';
import { StoreProfileController } from './presentation/store-profile.controller';
import { sellerFileSubscriptions } from './presentation/subscribers/seller-file.subscriptions';

/**
 * The Nest token of each dependency name the use cases of sellers share: a use case's
 * dependency object is built from these by {@link useCaseProvider}, so a name always means the
 * same port.
 */
const PORT = {
  unitOfWork: UNIT_OF_WORK,
  files: SELLER_FILE_REPOSITORY,
  slugs: SHOP_SLUG_REPOSITORY,
  policy: SELLER_MARKET_POLICY,
  registered: REGISTERED_SELLER_SOURCE,
  cipher: SELLER_FILE_CIPHER,
  counters: RATE_COUNTER_REPOSITORY,
  counterKeys: RATE_COUNTER_KEYS,
  addressFormats: ADDRESS_FORMATS,
  zones: TIMEZONE_RESOLVER,
  areas: SERVICE_AREAS,
  onboardingAreas: ONBOARDING_AREAS,
  list: SELLER_LIST_REPOSITORY,
  locationZones: LOCATION_TIMEZONE_RESOLVER,
  identifierSchemes: BUSINESS_IDENTIFIER_SCHEMES,
  identifierIndex: IDENTIFIER_INDEX,
  registerChecks: REGISTER_CHECK_REPOSITORY,
  registerLookups: BUSINESS_REGISTER_LOOKUPS,
  registerPolicy: REGISTER_LOOKUP_POLICY,
  taxProfiles: TAX_PROFILE_REPOSITORY,
  outbox: OUTBOX_WRITER,
  audit: AUDIT_WRITER,
  auditTrail: AUDIT_TRAIL_READER,
  teamMembers: TEAM_MEMBER_LABEL_SOURCE,
  revisions: BUSINESS_FILE_REVISION_REPOSITORY,
  sealer: REVISION_CONTENT_SEALER,
  accessReader: SELLER_ACCESS_READER,
  directory: SELLER_ACCOUNT_DIRECTORY,
  authorisation: AUTHORISATION_CHECK,
  notifier: REVIEWER_NOTIFIER,
  reviewChecks: REVIEW_CHECK_REPOSITORY,
  claims: IDENTIFIER_CLAIM_REPOSITORY,
  flags: ADMIN_FLAG_REPOSITORY,
  sellingFacts: SELLING_FACTS_REPOSITORY,
  blogAccess: BLOG_ACCESS_REPOSITORY,
  storeProfiles: STORE_PROFILE_REPOSITORY,
  publishedStores: PUBLISHED_STORE_REPOSITORY,
  minimumOrderPolicy: MINIMUM_ORDER_POLICY,
  storeContent: STORE_PROFILE_CONTENT_REPOSITORY,
  storeImages: STORE_IMAGE_REPOSITORY,
  contentSealer: STORE_PROFILE_CONTENT_SEALER,
  localesPolicy: STORE_PROFILE_LOCALES_POLICY,
  imageProcessor: STORE_IMAGE_PROCESSOR,
  claimCheck: STORE_TEXT_CLAIM_CHECK,
  publishedContent: PUBLISHED_STORE_CONTENT,
  objectStore: OBJECT_STORE,
  decider: SELLER_ACCESS_DECIDER,
  ids: ID_GENERATOR,
  clock: CLOCK,
} as const satisfies Record<string, InjectionToken>;

type PortName = keyof typeof PORT;

/**
 * The provider of one use case: the gate and the named ports, in a dependency object. `ports`
 * names every key of the use case's own dependency type, each a key of {@link PORT}, and no
 * other: the type checker refuses a missing, unknown or misnamed dependency.
 */
function useCaseProvider<D, U>(
  type: new (gate: UseCaseGate, deps: D) => U,
  ports: { readonly [K in keyof D]-?: K extends PortName ? true : never },
): FactoryProvider<U> {
  const names = Object.keys(ports) as PortName[];
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...names.map((name) => PORT[name])],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(gate, Object.fromEntries(names.map((name, index) => [name, values[index]])) as D),
  };
}

/** The ports of the may-sell contract (slice 9). */
const SELLING_ELIGIBILITY_PORTS = {
  unitOfWork: true,
  sellingFacts: true,
  accessReader: true,
  policy: true,
} as const;

/** The ports of the public store reads (slice 12): the may-sell contract's and the store rows. */
const PUBLISHED_STORE_PORTS = {
  ...SELLING_ELIGIBILITY_PORTS,
  publishedStores: true,
  storeProfiles: true,
  minimumOrderPolicy: true,
  publishedContent: true,
  clock: true,
} as const;

/** The ports every use case of the seller's own store profile reads with (slice 12 part 2). */
const STORE_PROFILE_READ_PORTS = {
  unitOfWork: true,
  storeProfiles: true,
  storeContent: true,
  storeImages: true,
  contentSealer: true,
  localesPolicy: true,
} as const;

/** The ports of the reviewer's approve and reject (slice 7a-decide). */
const REVIEW_DECISION_PORTS = {
  unitOfWork: true,
  accessReader: true,
  decider: true,
  registerChecks: true,
  registerPolicy: true,
  reviewChecks: true,
  files: true,
  revisions: true,
  claims: true,
  flags: true,
  slugs: true,
  ids: true,
  clock: true,
} as const;

/**
 * The sellers bounded context (docs/design/domain/sellers.md; ADR-0013), filled slice by slice.
 * Slice 1 binds its outbox writer and events, the file store, the Market policy and the source of
 * registered sellers (identity's seller-access contract); the handler `sellers.create-file` on
 * `identity.seller-registered.v1`; the deploy-time backfill job `sellers.backfill-files`; and the
 * facade with `sellerSummaries` (its two use cases). Slice 2 binds the seller's draft use cases
 * (`my-file.*`, `form-descriptors.read`) with the field cipher, the slug store, the rate
 * counters, the Market formats and the ServiceArea directory. Slice 3 adds the business
 * identifier (scheme adapters chosen by Market configuration, the keyed `IdentifierIndex`, the
 * validate and save use cases) and the tax-registration store (aggregate and repository; its use
 * case waits for the audit writer and the acting-as flag, see the slice 3 note in the data design).
 */
@Module({
  imports: [IdentityModule],
  controllers: [
    MyFileController,
    ReviewReadController,
    ReviewRegisterCheckController,
    ReviewDecisionController,
    BlogAccessController,
    SellerListController,
    StoreSettingsController,
    OwnZoneController,
    PublicStoreController,
    PublicStoreImageController,
    StoreProfileController,
  ],
  providers: [
    PersistenceModule.outboxWriterFor('sellers'),
    PersistenceModule.auditWriterFor('sellers'),
    PersistenceModule.auditTrailReaderFor('sellers'),
    registerEvents('sellers', SELLERS_EVENTS),
    registerAuditActions('sellers', SELLERS_AUDIT_ACTIONS),
    // Pushes its catalogue into the permission registry (identity slice 8a-1, PF 6.1).
    registerPermissions('sellers', SELLERS_PERMISSIONS),
    registerStepUpActions('sellers', SELLERS_STEP_UP_ACTIONS),
    ...sellerProviders,
    ...storeProfileProviders,
    useCaseProvider(CreateSellerFile, {
      unitOfWork: true,
      files: true,
      policy: true,
      outbox: true,
      clock: true,
    }),
    useCaseProvider(BackfillSellerFiles, {
      unitOfWork: true,
      files: true,
      policy: true,
      outbox: true,
      registered: true,
      clock: true,
    }),
    useCaseProvider(SellerSummaries, {
      unitOfWork: true,
      files: true,
      storeProfiles: true,
      minimumOrderPolicy: true,
    }),
    // Slice 20, the optional minimum order (design 18): store settings over HTTP through
    // StoreSettingsController, under `sellers.store-settings.edit`, approved sellers only.
    // The seller's own zone for the panel's time inputs (special-price windows).
    // Slice 12, the public store reads of the buyer site over HTTP through PublicStoreController
    // (rule `anonymous`; clear columns only, no key unwrapped).
    useCaseProvider(PublishedStoreList, PUBLISHED_STORE_PORTS),
    useCaseProvider(PublishedStoreRead, PUBLISHED_STORE_PORTS),
    useCaseProvider(PublishedStoreImageRead, { ...PUBLISHED_STORE_PORTS, objectStore: true }),
    // Slice 12 part 2, the seller's own store profile (design 3.7, 6.2) over HTTP through
    // StoreProfileController, under `sellers.store-profile.view` / `.edit`, approved sellers only.
    useCaseProvider(StoreProfileRead, STORE_PROFILE_READ_PORTS),
    useCaseProvider(StoreProfileSaveAbout, {
      ...STORE_PROFILE_READ_PORTS,
      audit: true,
      outbox: true,
      counters: true,
      counterKeys: true,
      claimCheck: true,
      ids: true,
      clock: true,
    }),
    useCaseProvider(StoreImageSave, {
      ...STORE_PROFILE_READ_PORTS,
      imageProcessor: true,
      objectStore: true,
      audit: true,
      counters: true,
      counterKeys: true,
      ids: true,
      clock: true,
    }),
    useCaseProvider(StoreImageRemove, {
      ...STORE_PROFILE_READ_PORTS,
      objectStore: true,
      audit: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    useCaseProvider(StoreImageReadOwn, {
      unitOfWork: true,
      storeProfiles: true,
      storeImages: true,
      objectStore: true,
    }),
    useCaseProvider(PublishedStoreSellerId, PUBLISHED_STORE_PORTS),
    useCaseProvider(PublishedStoreSlugs, PUBLISHED_STORE_PORTS),
    useCaseProvider(OwnZoneRead, { unitOfWork: true, revisions: true }),
    useCaseProvider(StoreSettingsRead, {
      unitOfWork: true,
      storeProfiles: true,
      minimumOrderPolicy: true,
    }),
    // Seller operations P-E: the minimum order's change history, from sellers' own audit rows.
    useCaseProvider(StoreSettingsMinimumOrderHistory, {
      unitOfWork: true,
      storeProfiles: true,
      auditTrail: true,
      teamMembers: true,
    }),
    useCaseProvider(StoreSettingsSaveMinimumOrder, {
      unitOfWork: true,
      storeProfiles: true,
      minimumOrderPolicy: true,
      audit: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    // Package e, the delivery terms: the same gate and deps as the minimum order.
    useCaseProvider(StoreSettingsSaveDelivery, {
      unitOfWork: true,
      storeProfiles: true,
      minimumOrderPolicy: true,
      audit: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    // Slice 2, the seller's draft (design 6.2), over HTTP through MyFileController, under
    // `sellers.business-identity.edit`: since identity slice 8a-1 the registry declares it and
    // the Seller Owner holds it through the seller system role; an account without it gets
    // access.denied.
    useCaseProvider(MyFileRead, {
      unitOfWork: true,
      files: true,
      revisions: true,
      accessReader: true,
      policy: true,
      identifierSchemes: true,
      cipher: true,
      addressFormats: true,
      zones: true,
      areas: true,
      registerChecks: true,
      registerPolicy: true,
      clock: true,
    }),
    useCaseProvider(MyFileSaveGeneral, {
      unitOfWork: true,
      files: true,
      revisions: true,
      outbox: true,
      policy: true,
      cipher: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    useCaseProvider(MyFileSaveAddress, {
      unitOfWork: true,
      files: true,
      revisions: true,
      outbox: true,
      policy: true,
      cipher: true,
      counters: true,
      counterKeys: true,
      addressFormats: true,
      zones: true,
      areas: true,
      locationZones: true,
      clock: true,
    }),
    useCaseProvider(MyFileSaveSlug, {
      unitOfWork: true,
      files: true,
      slugs: true,
      revisions: true,
      outbox: true,
      policy: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    useCaseProvider(MyFileCheckSlug, {
      unitOfWork: true,
      slugs: true,
      policy: true,
      files: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    // Slice 3, the business identifier (design 4.2, 6.2): validate (format and checksum only) and save.
    useCaseProvider(MyFileValidateIdentifier, {
      unitOfWork: true,
      identifierSchemes: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    // Slice 4a: the save also asks the Market's register (design 7.7); the reviewer reads the
    // state of a file's current identifier (no call, no decryption).
    useCaseProvider(MyFileSaveIdentifier, {
      unitOfWork: true,
      files: true,
      revisions: true,
      outbox: true,
      policy: true,
      identifierSchemes: true,
      identifierIndex: true,
      cipher: true,
      counters: true,
      counterKeys: true,
      registerChecks: true,
      registerLookups: true,
      registerPolicy: true,
      taxProfiles: true,
      addressFormats: true,
      clock: true,
    }),
    // Slice 5b: submit, withdraw, the handler that tells the reviewers, and the real zone read.
    useCaseProvider(MyFileSubmit, {
      unitOfWork: true,
      files: true,
      slugs: true,
      revisions: true,
      outbox: true,
      policy: true,
      identifierSchemes: true,
      areas: true,
      addressFormats: true,
      cipher: true,
      sealer: true,
      accessReader: true,
      ids: true,
      registerChecks: true,
      registerLookups: true,
      registerPolicy: true,
      taxProfiles: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    useCaseProvider(MyFileWithdraw, {
      accessReader: true,
      unitOfWork: true,
      files: true,
      revisions: true,
      outbox: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    useCaseProvider(AfterSubmission, {
      unitOfWork: true,
      revisions: true,
      counters: true,
      counterKeys: true,
      notifier: true,
      clock: true,
    }),
    useCaseProvider(ApprovedSellerZones, { unitOfWork: true, revisions: true }),
    useCaseProvider(ApprovedSellerZonesSystem, { unitOfWork: true, revisions: true }),
    // Slice 7a-read, the review page (design 6.2, 8.3, 9): decrypts one seller's revisions under
    // `sellers.business-details.view` and audits each read in its own unit.
    useCaseProvider(ReviewRead, {
      unitOfWork: true,
      files: true,
      revisions: true,
      sealer: true,
      registerChecks: true,
      registerPolicy: true,
      reviewChecks: true,
      accessReader: true,
      identifierSchemes: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(ReviewRegisterCheckRead, {
      unitOfWork: true,
      files: true,
      registerChecks: true,
      registerPolicy: true,
      clock: true,
    }),
    // Slice 7a-decide, the reviewer's decision (design 3.1, 7.3): approve and reject under
    // `identity.seller-access.approve`, the manual register check under `sellers.seller-file.review`,
    // and the two paths that finish a decision whose request died: the handler of identity's
    // decision events and the reconciliation job.
    useCaseProvider(ReviewApprove, REVIEW_DECISION_PORTS),
    useCaseProvider(ReviewReject, REVIEW_DECISION_PORTS),
    useCaseProvider(ReviewRecordManualCheck, {
      unitOfWork: true,
      files: true,
      revisions: true,
      reviewChecks: true,
      audit: true,
      clock: true,
    }),
    useCaseProvider(CloseDecision, {
      unitOfWork: true,
      files: true,
      revisions: true,
      claims: true,
      flags: true,
      slugs: true,
      ids: true,
      clock: true,
    }),
    useCaseProvider(ReconcileDecisions, {
      unitOfWork: true,
      decider: true,
      accessReader: true,
      files: true,
      revisions: true,
      claims: true,
      flags: true,
      slugs: true,
      ids: true,
      clock: true,
    }),
    // Slices 6 and 6b, the admin seller list (design 6.2, 7.8), over HTTP through
    // SellerListController, under `sellers.seller.view`; the row status, the owner and the
    // identity-state tabs only for an actor that also holds `identity.seller-access.view`.
    useCaseProvider(SellerList, {
      unitOfWork: true,
      list: true,
      directory: true,
      authorisation: true,
      onboardingAreas: true,
    }),
    useCaseProvider(FormDescriptorsRead, { addressFormats: true, zones: true, policy: true }),
    useCaseProvider(SellerSummariesSystem, {
      unitOfWork: true,
      files: true,
      storeProfiles: true,
      minimumOrderPolicy: true,
    }),
    // Slice 9, the may-sell contract and the allowed product types (design 7.1, 7.2).
    useCaseProvider(SellingEligibility, SELLING_ELIGIBILITY_PORTS),
    useCaseProvider(SellingEligibilitySystem, SELLING_ELIGIBILITY_PORTS),
    useCaseProvider(AllowedProductTypes, { unitOfWork: true, sellingFacts: true }),
    useCaseProvider(AllowedProductTypesSystem, { unitOfWork: true, sellingFacts: true }),
    // The blog switch of a seller (blog package 1): the read pair and the admin's set.
    useCaseProvider(BlogAccess, { unitOfWork: true, sellingFacts: true }),
    useCaseProvider(BlogAccessSystem, { unitOfWork: true, sellingFacts: true }),
    // Since when a seller has been approved, for promotions' new-seller rule: the read pair.
    useCaseProvider(ActiveSince, { unitOfWork: true, sellingFacts: true }),
    useCaseProvider(ActiveSinceSystem, { unitOfWork: true, sellingFacts: true }),
    useCaseProvider(BlogAccessSetUseCase, {
      unitOfWork: true,
      blogAccess: true,
      audit: true,
      outbox: true,
      clock: true,
    }),
    // The certification reviewer's read of one approved revision's names and addresses
    // (design 7.1, Hassan M4): audited per read.
    useCaseProvider(ReviewerBusinessDetailsRead, {
      unitOfWork: true,
      revisions: true,
      sealer: true,
      audit: true,
    }),
    // The real-time carrier's pickup of a paid seller order (SHP-02/03): audited per read.
    useCaseProvider(CarrierPickupRead, {
      unitOfWork: true,
      revisions: true,
      sealer: true,
      audit: true,
    }),
    // The pickup postcode the real-time carrier quotes from at checkout: a clear column, no audit.
    useCaseProvider(PickupPostcodes, { unitOfWork: true, revisions: true }),
    // The seller's approved operating zone, for shipping's cut-off and windows: a clear column.
    useCaseProvider(OperatingZones, { unitOfWork: true, revisions: true }),
    {
      provide: SELLERS_FACADE,
      inject: [
        SellerSummaries,
        SellerSummariesSystem,
        SellingEligibility,
        SellingEligibilitySystem,
        AllowedProductTypes,
        AllowedProductTypesSystem,
        BlogAccess,
        BlogAccessSystem,
        ActiveSince,
        ActiveSinceSystem,
        ReviewerBusinessDetailsRead,
        PublishedStoreSellerId,
        PublishedStoreSlugs,
        CarrierPickupRead,
        PickupPostcodes,
        OperatingZones,
      ],
      useFactory: (
        sellerSummaries: SellerSummaries,
        sellerSummariesSystem: SellerSummariesSystem,
        sellingEligibility: SellingEligibility,
        sellingEligibilitySystem: SellingEligibilitySystem,
        allowedProductTypes: AllowedProductTypes,
        allowedProductTypesSystem: AllowedProductTypesSystem,
        blogAccess: BlogAccess,
        blogAccessSystem: BlogAccessSystem,
        activeSince: ActiveSince,
        activeSinceSystem: ActiveSinceSystem,
        reviewerBusinessDetails: ReviewerBusinessDetailsRead,
        publishedStoreSellerId: PublishedStoreSellerId,
        publishedStoreSlugs: PublishedStoreSlugs,
        carrierPickup: CarrierPickupRead,
        pickupPostcodes: PickupPostcodes,
        operatingZones: OperatingZones,
      ) =>
        new SellersFacadeImplementation({
          sellerSummaries,
          sellerSummariesSystem,
          sellingEligibility,
          sellingEligibilitySystem,
          allowedProductTypes,
          allowedProductTypesSystem,
          blogAccess,
          blogAccessSystem,
          activeSince,
          activeSinceSystem,
          reviewerBusinessDetails,
          publishedStoreSellerId,
          publishedStoreSlugs,
          carrierPickup,
          pickupPostcodes,
          operatingZones,
        }),
    },
    // The zone contract is a provider of its own (not a facade method) and is imported by
    // certification's application layer only (dependency-cruiser).
    {
      provide: APPROVED_SELLER_ZONES,
      inject: [ApprovedSellerZones, ApprovedSellerZonesSystem],
      useFactory: (
        approvedSellerZones: ApprovedSellerZones,
        approvedSellerZonesSystem: ApprovedSellerZonesSystem,
      ) =>
        new ApprovedSellerZonesReaderImplementation({
          approvedSellerZones,
          approvedSellerZonesSystem,
        }),
    },
    useCaseProvider(PurgeExpired, { unitOfWork: true, counters: true, clock: true }),
    registerJobsFrom(
      'sellers',
      [BackfillSellerFiles, PurgeExpired, ReconcileDecisions],
      (backfill: BackfillSellerFiles, purge: PurgeExpired, reconcile: ReconcileDecisions) => [
        backfillSellerFilesJob(backfill),
        purgeExpiredJob(purge),
        reconcileDecisionsJob(reconcile),
      ],
    ),
    registerSubscriptionsFrom(
      'sellers',
      [CreateSellerFile, AfterSubmission, CloseDecision],
      (
        createFile: CreateSellerFile,
        afterSubmission: AfterSubmission,
        closeDecision: CloseDecision,
      ) => [
        ...sellerFileSubscriptions(createFile, afterSubmission),
        ...decisionSubscriptions(closeDecision),
      ],
    ),
  ],
  // STORE_TEXT_CLAIM_CHECK: SellerStoreProfileModule binds certification to it at start.
  exports: [SELLERS_FACADE, APPROVED_SELLER_ZONES, STORE_TEXT_CLAIM_CHECK],
})
export class SellersModule {}
