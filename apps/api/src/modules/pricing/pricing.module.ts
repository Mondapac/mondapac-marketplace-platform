import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { OUTBOX_WRITER } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { CatalogModule } from '../catalog';
import { OFFER_SELL_UNITS_SOURCE } from './application/ports/offer-sell-units';
import { PRICE_SERIES_REPOSITORY } from './application/ports/price-series.repository';
import { PRICING_POLICY_PROVIDER } from './application/ports/pricing-policy-provider';
import { WRITE_REFUSAL_THROTTLE_REPOSITORY } from './application/ports/write-refusal-throttle.repository';
import { PurgeWriteRefusalThrottles } from './application/use-cases/purge-write-refusal-throttles.use-case';
import { SetRegularPrice } from './application/use-cases/set-regular-price.use-case';
import { PRICING_PERMISSIONS } from './contracts/permissions';
import { PRICING_AUDIT_ACTIONS } from './domain/audit';
import { PRICING_EVENTS } from './domain/events';
import { pricingProviders } from './infrastructure/pricing-providers';
import { purgeWriteRefusalThrottlesJob } from './presentation/jobs/purge-write-refusal-throttles.job';

/**
 * The Nest token of each dependency name the use cases of pricing share: a use case's dependency
 * object is built from these by {@link useCaseProvider}, so a name always means the same port.
 */
const PORT = {
  unitOfWork: UNIT_OF_WORK,
  series: PRICE_SERIES_REPOSITORY,
  throttles: WRITE_REFUSAL_THROTTLE_REPOSITORY,
  offers: OFFER_SELL_UNITS_SOURCE,
  policies: PRICING_POLICY_PROVIDER,
  audit: AUDIT_WRITER,
  outbox: OUTBOX_WRITER,
  clock: CLOCK,
  ids: ID_GENERATOR,
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
 * The pricing module (ADR-0024; docs/design/domain/pricing.md). Slice 1 so far: the pure domain
 * (part 1), its persistence ports (part 2), the Market policy (part 3a) and, in part 3b, the
 * application layer of the seller's regular-price write: the permission catalogue, the events,
 * the audited actions, `pricing.set-regular-price`, and the hourly purge of the refusal
 * counters. The route, the read facade and the retirement handlers arrive in later parts; until
 * catalog slice 7, catalog's fail-closed `offerSellUnits` answers every Offer as absent, so every
 * write answers `pricing.offer-not-found`.
 */
@Module({
  imports: [CatalogModule],
  providers: [
    PersistenceModule.outboxWriterFor('pricing'),
    PersistenceModule.auditWriterFor('pricing'),
    registerEvents('pricing', PRICING_EVENTS),
    registerAuditActions('pricing', PRICING_AUDIT_ACTIONS),
    // Pushes its catalogue into the permission registry (identity slice 8a-1, PF 6.1).
    registerPermissions('pricing', PRICING_PERMISSIONS),
    ...pricingProviders,
    useCaseProvider(SetRegularPrice, {
      unitOfWork: true,
      series: true,
      throttles: true,
      offers: true,
      policies: true,
      audit: true,
      outbox: true,
      clock: true,
      ids: true,
    }),
    useCaseProvider(PurgeWriteRefusalThrottles, { unitOfWork: true, throttles: true, clock: true }),
    registerJobsFrom(
      'pricing',
      [PurgeWriteRefusalThrottles],
      (purge: PurgeWriteRefusalThrottles) => [purgeWriteRefusalThrottlesJob(purge)],
    ),
  ],
})
export class PricingModule {}
