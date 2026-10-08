import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { IdentityModule } from '../identity';
import { RATE_COUNTER_KEYS } from './application/ports/rate-counter-keys';
import { RATE_COUNTER_REPOSITORY } from './application/ports/rate-counter.repository';
import { REGISTERED_SELLER_SOURCE } from './application/ports/registered-seller-source';
import { SELLER_FILE_CIPHER } from './application/ports/seller-file-cipher';
import { SELLER_FILE_REPOSITORY } from './application/ports/seller-file.repository';
import {
  ADDRESS_FORMATS,
  SERVICE_AREAS,
  TIMEZONE_RESOLVER,
} from './application/ports/seller-market-formats';
import { SELLER_MARKET_POLICY } from './application/ports/seller-market-policy';
import { SHOP_SLUG_REPOSITORY } from './application/ports/shop-slug.repository';
import { BackfillSellerFiles } from './application/use-cases/backfill-seller-files.use-case';
import { CreateSellerFile } from './application/use-cases/create-seller-file.use-case';
import { FormDescriptorsRead } from './application/use-cases/form-descriptors-read.use-case';
import { MyFileCheckSlug } from './application/use-cases/my-file-check-slug.use-case';
import { MyFileRead } from './application/use-cases/my-file-read.use-case';
import { MyFileSaveAddress } from './application/use-cases/my-file-save-address.use-case';
import { MyFileSaveGeneral } from './application/use-cases/my-file-save-general.use-case';
import { SellerSummariesSystem } from './application/use-cases/seller-summaries-system.use-case';
import { SellerSummaries } from './application/use-cases/seller-summaries.use-case';
import { SellingEligibilitySystem } from './application/use-cases/selling-eligibility-system.use-case';
import { SellingEligibility } from './application/use-cases/selling-eligibility.use-case';
import { SELLERS_FACADE } from './contracts/sellers.facade';
import { SELLERS_EVENTS } from './domain/events';
import { sellerProviders } from './infrastructure/seller-providers';
import { backfillSellerFilesJob } from './presentation/jobs/backfill-seller-files.job';
import { SellersFacadeImplementation } from './presentation/sellers.facade';
import { MyFileController } from './presentation/my-file.controller';
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
  outbox: OUTBOX_WRITER,
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
 * counters, the Market formats and the ServiceArea directory.
 */
@Module({
  imports: [IdentityModule],
  controllers: [MyFileController],
  providers: [
    PersistenceModule.outboxWriterFor('sellers'),
    registerEvents('sellers', SELLERS_EVENTS),
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
    // Slice 2, the seller's draft (design 6.2), over HTTP through MyFileController. The
    // permission key is held once identity slice 8a brings the registry and role keys (until
    // then the gate refuses every route with access.denied).
    useCaseProvider(MyFileRead, {
      unitOfWork: true,
      files: true,
      cipher: true,
      addressFormats: true,
      zones: true,
      areas: true,
    }),
    useCaseProvider(MyFileSaveGeneral, {
      unitOfWork: true,
      files: true,
      cipher: true,
      counters: true,
      counterKeys: true,
      clock: true,
    }),
    useCaseProvider(MyFileSaveAddress, {
      unitOfWork: true,
      files: true,
      cipher: true,
      counters: true,
      counterKeys: true,
      addressFormats: true,
      zones: true,
      areas: true,
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
    useCaseProvider(FormDescriptorsRead, { addressFormats: true, zones: true }),
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
    registerJobsFrom('sellers', [BackfillSellerFiles], (backfill: BackfillSellerFiles) => [
      backfillSellerFilesJob(backfill),
    ]),
    registerSubscriptionsFrom('sellers', [CreateSellerFile], (createFile: CreateSellerFile) =>
      sellerFileSubscriptions(createFile),
    ),
  ],
  exports: [SELLERS_FACADE],
})
export class SellersModule {}
