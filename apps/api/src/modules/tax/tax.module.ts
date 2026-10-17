import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { STRATEGY_REPOSITORY } from './application/ports/strategy.repository';
import { TAX_POLICY } from './application/ports/tax-policy';
import type { TaxDependencies } from './application/tax-dependencies';
import { ActivateTaxStrategy } from './application/use-cases/activate-tax-strategy.use-case';
import { CalculateTax } from './application/use-cases/calculate-tax.use-case';
import { CreateTaxStrategy } from './application/use-cases/create-tax-strategy.use-case';
import { DeleteTaxStrategy } from './application/use-cases/delete-tax-strategy.use-case';
import { ListTaxStrategies } from './application/use-cases/list-tax-strategies.use-case';
import { UpdateTaxStrategy } from './application/use-cases/update-tax-strategy.use-case';
import { TAX_FACADE, TAX_PERMISSIONS } from './contracts';
import { TAX_AUDIT_ACTIONS } from './domain/audit';
import { taxProviders } from './infrastructure/tax-providers';
import { TaxFacadeImplementation } from './presentation/tax.facade';
import { AdminTaxController } from './presentation/tax.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: TaxDependencies) => U;

const PORTS: readonly [keyof TaxDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['strategies', STRATEGY_REPOSITORY],
  ['policy', TAX_POLICY],
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

/** Every tax use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as TaxDependencies,
      ),
  };
}

/**
 * Tax: how the tax of an order line is worked out. The Market has a built-in flat strategy (Market
 * config, AU GST 10 %); an admin may define other strategies (a flat rate, or a rate per tax
 * category) and pick the one in force. `ordering` asks for the tax of a cart through `TAX_FACADE`
 * and freezes the answer on the order. No official invoice and no GST refund yet: those wait for
 * the registered tax agent's written confirmation.
 */
@Module({
  controllers: [AdminTaxController],
  providers: [
    PersistenceModule.auditWriterFor('tax'),
    registerAuditActions('tax', TAX_AUDIT_ACTIONS),
    registerPermissions('tax', TAX_PERMISSIONS),
    ...taxProviders,
    ...[
      CalculateTax,
      ListTaxStrategies,
      CreateTaxStrategy,
      UpdateTaxStrategy,
      DeleteTaxStrategy,
      ActivateTaxStrategy,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: TAX_FACADE,
      inject: [CalculateTax],
      useFactory: (calculate: CalculateTax) => new TaxFacadeImplementation(calculate),
    },
  ],
  exports: [TAX_FACADE],
})
export class TaxModule {}
