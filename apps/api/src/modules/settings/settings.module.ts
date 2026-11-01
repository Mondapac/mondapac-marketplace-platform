import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { MARKET_SETTING_REPOSITORY } from './application/ports/market-setting.repository';
import type { SettingsDependencies } from './application/settings-dependencies';
import { ChangeMarketSetting } from './application/use-cases/change-market-setting.use-case';
import { ReadListPaging } from './application/use-cases/read-list-paging.use-case';
import { ViewMarketSettings } from './application/use-cases/view-market-settings.use-case';
import { SETTINGS_AUDIT_ACTIONS, SETTINGS_PERMISSIONS } from './contracts';
import { settingsProviders } from './infrastructure/settings-providers';
import {
  AdminSettingsController,
  SellerSettingsController,
} from './presentation/settings.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: SettingsDependencies) => U;

const PORTS: readonly [keyof SettingsDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['settings', MARKET_SETTING_REPOSITORY],
  ['audit', AUDIT_WRITER],
  ['clock', CLOCK],
];

/** Every settings use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as SettingsDependencies,
      ),
  };
}

/**
 * Settings (admin-editable Market settings, ADR-0026 and ADR-0040): one shared store with a
 * version, an insert-only history and an audit row per change, in the `settings` schema. List
 * paging is its first setting. The settings other modules already keep are not moved here.
 */
@Module({
  controllers: [AdminSettingsController, SellerSettingsController],
  providers: [
    PersistenceModule.auditWriterFor('settings'),
    registerAuditActions('settings', SETTINGS_AUDIT_ACTIONS),
    registerPermissions('settings', SETTINGS_PERMISSIONS),
    ...settingsProviders,
    ...[ViewMarketSettings, ChangeMarketSetting, ReadListPaging].map((type) =>
      useCaseProvider(type as UseCaseClass<unknown>),
    ),
  ],
})
export class SettingsModule {}
