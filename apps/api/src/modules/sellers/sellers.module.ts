import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import {
  AUTHORISATION_CHECK,
  registerPermissions,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
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
import { ReviewRegisterCheckRead } from './application/use-cases/review-register-check-read.use-case';
import { PurgeExpired } from './application/use-cases/purge-expired.use-case';
import { SellerList } from './application/use-cases/list.use-case';
import { SellerSummariesSystem } from './application/use-cases/seller-summaries-system.use-case';
import { SellerSummaries } from './application/use-cases/seller-summaries.use-case';
import { SellingEligibilitySystem } from './application/use-cases/selling-eligibility-system.use-case';
import { SellingEligibility } from './application/use-cases/selling-eligibility.use-case';
import { SELLERS_PERMISSIONS } from './contracts/permissions';
import { APPROVED_SELLER_ZONES } from './contracts/approved-seller-zones.contract';
import { SELLERS_FACADE } from './contracts/sellers.facade';
import { SELLERS_EVENTS } from './domain/events';
import { sellerProviders } from './infrastructure/seller-providers';
import { purgeExpiredJob } from './presentation/jobs/purge-expired.job';
import { backfillSellerFilesJob } from './presentation/jobs/backfill-seller-files.job';
import { ApprovedSellerZonesReaderImplementation } from './presentation/approved-seller-zones.reader';
import { SellersFacadeImplementation } from './presentation/sellers.facade';
import { MyFileController } from './presentation/my-file.controller';
import { ReviewRegisterCheckController } from './presentation/review-register-check.controller';
import { SellerListController } from './presentation/seller-list.controller';
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
  revisions: BUSINESS_FILE_REVISION_REPOSITORY,
  sealer: REVISION_CONTENT_SEALER,
  accessReader: SELLER_ACCESS_READER,
  authorisation: AUTHORISATION_CHECK,
  notifier: REVIEWER_NOTIFIER,
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
  controllers: [MyFileController, ReviewRegisterCheckController, SellerListController],
  providers: [
    PersistenceModule.outboxWriterFor('sellers'),
    registerEvents('sellers', SELLERS_EVENTS),
    // Pushes its catalogue into the permission registry (identity slice 8a-1, PF 6.1).
    registerPermissions('sellers', SELLERS_PERMISSIONS),
    ...sellerProviders,
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
    useCaseProvider(SellerSummaries, { unitOfWork: true, files: true }),
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
    useCaseProvider(ReviewRegisterCheckRead, {
      unitOfWork: true,
      files: true,
      registerChecks: true,
      registerPolicy: true,
      clock: true,
    }),
    // Slice 6, the admin seller list (design 6.2, 7.8), over HTTP through SellerListController,
    // under `sellers.seller.view`: clear fields only, one `identity` call per page, and the row status
    // only for an actor that also holds `identity.seller-access.view`.
    useCaseProvider(SellerList, {
      unitOfWork: true,
      list: true,
      accessReader: true,
      authorisation: true,
      onboardingAreas: true,
    }),
    useCaseProvider(FormDescriptorsRead, { addressFormats: true, zones: true, policy: true }),
    useCaseProvider(SellerSummariesSystem, { unitOfWork: true, files: true }),
    // The fail-closed stand-in of slice 9 (design 7.2): it reads nothing, so only the gate.
    ...[SellingEligibility, SellingEligibilitySystem].map((type): FactoryProvider => ({
      provide: type,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate) => new type(gate),
    })),
    {
      provide: SELLERS_FACADE,
      inject: [
        SellerSummaries,
        SellerSummariesSystem,
        SellingEligibility,
        SellingEligibilitySystem,
      ],
      useFactory: (
        sellerSummaries: SellerSummaries,
        sellerSummariesSystem: SellerSummariesSystem,
        sellingEligibility: SellingEligibility,
        sellingEligibilitySystem: SellingEligibilitySystem,
      ) =>
        new SellersFacadeImplementation({
          sellerSummaries,
          sellerSummariesSystem,
          sellingEligibility,
          sellingEligibilitySystem,
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
      [BackfillSellerFiles, PurgeExpired],
      (backfill: BackfillSellerFiles, purge: PurgeExpired) => [
        backfillSellerFilesJob(backfill),
        purgeExpiredJob(purge),
      ],
    ),
    registerSubscriptionsFrom(
      'sellers',
      [CreateSellerFile, AfterSubmission],
      (createFile: CreateSellerFile, afterSubmission: AfterSubmission) =>
        sellerFileSubscriptions(createFile, afterSubmission),
    ),
  ],
  exports: [SELLERS_FACADE, APPROVED_SELLER_ZONES],
})
export class SellersModule {}
