import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { SellersModule } from '../sellers';
import { FLAT_FEE_REPOSITORY } from './application/ports/flat-fee.repository';
import { SELLER_DIRECTORY } from './application/ports/seller-directory';
import { SHIPPING_POLICY } from './application/ports/shipping-policy';
import type { ShippingDependencies } from './application/shipping-dependencies';
import { FlatFees } from './application/use-cases/flat-fees.use-case';
import { SetFlatFee } from './application/use-cases/set-flat-fee.use-case';
import { ViewFlatFee } from './application/use-cases/view-flat-fee.use-case';
import { ViewOwnFlatFee } from './application/use-cases/view-own-flat-fee.use-case';
import { SHIPPING_FACADE, SHIPPING_PERMISSIONS } from './contracts';
import { SHIPPING_AUDIT_ACTIONS } from './domain/audit';
import { shippingProviders } from './infrastructure/shipping-providers';
import {
  AdminFlatFeeController,
  SellerFlatFeeController,
} from './presentation/flat-fee.controller';
import { ShippingFacadeImplementation } from './presentation/shipping.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: ShippingDependencies) => U;

const PORTS: readonly [keyof ShippingDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['fees', FLAT_FEE_REPOSITORY],
  ['policy', SHIPPING_POLICY],
  ['sellers', SELLER_DIRECTORY],
  ['audit', AUDIT_WRITER],
  ['clock', CLOCK],
];

/** Every shipping use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as ShippingDependencies,
      ),
  };
}

/**
 * Shipping (Phase 5 package 4, SHP-01, speed mode). The flat shipping fee of each seller: an
 * admin sets it, the seller sees it, and `ordering` reads it through `SHIPPING_FACADE` at
 * checkout (a seller without a fee cannot be bought from). Real carrier rates are Phase 6.
 */
@Module({
  imports: [SellersModule],
  controllers: [AdminFlatFeeController, SellerFlatFeeController],
  providers: [
    PersistenceModule.auditWriterFor('shipping'),
    registerAuditActions('shipping', SHIPPING_AUDIT_ACTIONS),
    registerPermissions('shipping', SHIPPING_PERMISSIONS),
    ...shippingProviders,
    ...[SetFlatFee, ViewFlatFee, ViewOwnFlatFee, FlatFees].map((type) =>
      useCaseProvider(type as UseCaseClass<unknown>),
    ),
    {
      provide: SHIPPING_FACADE,
      inject: [FlatFees],
      useFactory: (fees: FlatFees) => new ShippingFacadeImplementation(fees),
    },
  ],
  exports: [SHIPPING_FACADE],
})
export class ShippingModule {}
