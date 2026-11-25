import { IDENTITY_FACADE, IdentityModule, type IdentityFacade } from '../identity';
import { SETTINGS_ADMIN_NAMES, type AdminNames } from './application/ports/admin-names';
import { ChangeOfferReviewEmergencyStop } from './application/use-cases/change-offer-review-emergency-stop.use-case';
import { ViewOfferReviewEmergencyStop } from './application/use-cases/view-offer-review-emergency-stop.use-case';
import { FacadeAdminNames } from './infrastructure/facade-admin-names';
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
import { SETTINGS_STEP_UP_ACTIONS } from './contracts/step-up';
import { CLOCK } from '../../platform/clock/clock.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { MARKET_SETTING_REPOSITORY } from './application/ports/market-setting.repository';
import type { SettingsDependencies } from './application/settings-dependencies';
import { SETTING_SUBJECT_KIND, SETTINGS_REVIEW_AREA } from './application/settings-flow';
import { SettingsReverter } from './application/settings-reverter';
import { createSystemChangeRegistrar, SYSTEM_REQUEST_RECORDER } from '../system-requests';
import { ChangeAiSetting } from './application/use-cases/change-ai-setting.use-case';
import { ReadAiDescriptionWriter } from './application/use-cases/read-ai-description-writer.use-case';
import { ReadCartMode } from './application/use-cases/read-cart-mode.use-case';
import { ReadOfferQueueBacklogLimits } from './application/use-cases/read-offer-queue-backlog-limits.use-case';
import { ChangeMonthlyRevenueTargetSetting } from './application/use-cases/change-monthly-revenue-target-setting.use-case';
import { ReadMonthlyRevenueTarget } from './application/use-cases/read-monthly-revenue-target.use-case';
import { ViewMonthlyRevenueTargetSetting } from './application/use-cases/view-monthly-revenue-target-setting.use-case';
import { MarketRegistry } from '../../platform/market-config/market-registry';
import { ViewAiSettings } from './application/use-cases/view-ai-settings.use-case';
import { ChangeOfferReviewSettings } from './application/use-cases/change-offer-review-settings.use-case';
import { ViewOfferReviewSettings } from './application/use-cases/view-offer-review-settings.use-case';
import { ReadOfferReviewPolicy } from './application/use-cases/read-offer-review-policy.use-case';
import { ChangeCartModeSetting } from './application/use-cases/change-cart-mode-setting.use-case';
import { ChangeListPagingSetting } from './application/use-cases/change-list-paging-setting.use-case';
import { ReadListPaging } from './application/use-cases/read-list-paging.use-case';
import { ViewCartModeSetting } from './application/use-cases/view-cart-mode-setting.use-case';
import { ViewListPagingSetting } from './application/use-cases/view-list-paging-setting.use-case';
import { SETTINGS_AUDIT_ACTIONS, SETTINGS_FACADE, SETTINGS_PERMISSIONS } from './contracts';
import { SettingsFacadeImplementation } from './presentation/settings.facade';
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
  ['review', SYSTEM_REQUEST_RECORDER],
  ['stepUp', STEP_UP_CONSUMER],
];

/** The reverter of a Market setting change, registered with System requests below. */
const SETTINGS_REVERTER = Symbol('SETTINGS_REVERTER');
/** This module's own registrar for System requests (never exported from the barrel). */
const SETTINGS_SYSTEM_CHANGES = createSystemChangeRegistrar('settings');

const dependenciesOf = (values: readonly unknown[]): SettingsDependencies =>
  Object.fromEntries(
    PORTS.map(([name], index) => [name, values[index]]),
  ) as unknown as SettingsDependencies;

/** Every settings use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) => new type(gate, dependenciesOf(values)),
  };
}

/**
 * Settings (admin-editable Market settings, ADR-0026 and ADR-0042): one shared store with a
 * version, an insert-only history and an audit row per change, in the `settings` schema. List
 * paging is its first setting, Cart mode its second, the AI description writer's switch and tier
 * the next two, the Offer review policy (risk-based Offer approval) the next six and the monthly revenue target (an amount) the one after. The settings other modules already keep are not moved here. A change opens a
 * review in Admin Inbox › System requests (area marketplace) when the Market reviews that area,
 * and a rejected or withdrawn one is restored by the registered reverter.
 */
@Module({
  imports: [IdentityModule],
  controllers: [AdminSettingsController, SellerSettingsController],
  providers: [
    PersistenceModule.auditWriterFor('settings'),
    registerAuditActions('settings', SETTINGS_AUDIT_ACTIONS),
    registerPermissions('settings', SETTINGS_PERMISSIONS),
    registerStepUpActions('settings', SETTINGS_STEP_UP_ACTIONS),
    ...settingsProviders,
    ...[
      ViewListPagingSetting,
      ChangeListPagingSetting,
      ReadListPaging,
      ViewCartModeSetting,
      ChangeCartModeSetting,
      ViewAiSettings,
      ChangeAiSetting,
      ViewOfferReviewSettings,
      ChangeOfferReviewSettings,
      ChangeOfferReviewEmergencyStop,
      ReadOfferReviewPolicy,
      ReadAiDescriptionWriter,
      ReadCartMode,
      ReadOfferQueueBacklogLimits,
      ViewMonthlyRevenueTargetSetting,
      ReadMonthlyRevenueTarget,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: ChangeMonthlyRevenueTargetSetting,
      inject: [USE_CASE_GATE, MarketRegistry, ...PORTS.map(([, token]) => token)],
      useFactory: (gate: UseCaseGate, markets: MarketRegistry, ...values: unknown[]) =>
        new ChangeMonthlyRevenueTargetSetting(gate, dependenciesOf(values), {
          currencyOf: (market) => markets.get(market.marketId).defaultCurrency,
        }),
    },
    {
      provide: SETTINGS_ADMIN_NAMES,
      inject: [IDENTITY_FACADE],
      useFactory: (identity: IdentityFacade): AdminNames => new FacadeAdminNames(identity),
    },
    {
      provide: ViewOfferReviewEmergencyStop,
      inject: [USE_CASE_GATE, SETTINGS_ADMIN_NAMES, ...PORTS.map(([, token]) => token)],
      useFactory: (gate: UseCaseGate, names: AdminNames, ...values: unknown[]) =>
        new ViewOfferReviewEmergencyStop(gate, { settings: dependenciesOf(values), names }),
    },
    {
      provide: SETTINGS_REVERTER,
      inject: PORTS.map(([, token]) => token),
      useFactory: (...values: unknown[]) => new SettingsReverter(dependenciesOf(values)),
    },
    SETTINGS_SYSTEM_CHANGES.reverter(SETTING_SUBJECT_KIND, SETTINGS_REVIEW_AREA, SETTINGS_REVERTER),
    {
      provide: SETTINGS_FACADE,
      inject: [
        ReadAiDescriptionWriter,
        ReadCartMode,
        ReadMonthlyRevenueTarget,
        ReadOfferReviewPolicy,
        ReadOfferQueueBacklogLimits,
      ],
      useFactory: (
        read: ReadAiDescriptionWriter,
        cartMode: ReadCartMode,
        target: ReadMonthlyRevenueTarget,
        offerReview: ReadOfferReviewPolicy,
        backlogLimits: ReadOfferQueueBacklogLimits,
      ) => new SettingsFacadeImplementation(read, cartMode, target, offerReview, backlogLimits),
    },
  ],
  exports: [SETTINGS_FACADE],
})
export class SettingsModule {}
