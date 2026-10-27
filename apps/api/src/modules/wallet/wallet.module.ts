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
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { MARKET_SETTING_REPOSITORY } from './application/ports/market-setting.repository';
import { WALLET_POLICY } from './application/ports/wallet-policy';
import { WALLET_REPOSITORY } from './application/ports/wallet.repository';
import { BalanceOf } from './application/use-cases/balance-of.use-case';
import { CaptureHold } from './application/use-cases/capture-hold.use-case';
import { ExpireWalletCredit } from './application/use-cases/expire-wallet-credit.use-case';
import { GrantCredit } from './application/use-cases/grant-credit.use-case';
import { OwnBalanceOf } from './application/use-cases/own-balance-of.use-case';
import { PlaceHold } from './application/use-cases/place-hold.use-case';
import { ReleaseHold } from './application/use-cases/release-hold.use-case';
import { SetWalletStatus } from './application/use-cases/set-wallet-status.use-case';
import { ViewMyHistory } from './application/use-cases/view-my-history.use-case';
import { ViewMyWallet } from './application/use-cases/view-my-wallet.use-case';
import { ViewWalletSettings } from './application/use-cases/view-wallet-settings.use-case';
import type { WalletDependencies } from './application/wallet-dependencies';
import {
  WALLET_AUDIT_ACTIONS,
  WALLET_FACADE,
  WALLET_PERMISSIONS,
  WALLET_STEP_UP_ACTIONS,
} from './contracts';
import { walletProviders } from './infrastructure/wallet-providers';
import { expireWalletCreditJob } from './presentation/jobs/expire-wallet-credit.job';
import { AdminWalletController, CustomerWalletController } from './presentation/wallet.controller';
import { WalletFacadeImplementation } from './presentation/wallet.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: WalletDependencies) => U;

const PORTS: readonly [keyof WalletDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['wallet', WALLET_REPOSITORY],
  ['settings', MARKET_SETTING_REPOSITORY],
  ['policy', WALLET_POLICY],
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
  ['stepUp', STEP_UP_CONSUMER],
];

/** Every wallet use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as WalletDependencies,
      ),
  };
}

/**
 * Wallet (customer wallet package 1, speed mode): the ledger core of platform-issued store
 * credit. Lots, holds, balanced insert-only journals and the cached balance live in the `wallet`
 * schema. Other modules call `WALLET_FACADE` (system callers; no ordering wiring yet); the
 * signed-in customer reads `GET /wallet/me` and `/wallet/me/history`; an admin moves the Market
 * switch (off, active, paused, frozen) at runtime. A worker job expires holds and promo credit.
 * No card, bank or Stripe call exists here.
 */
@Module({
  controllers: [AdminWalletController, CustomerWalletController],
  providers: [
    PersistenceModule.auditWriterFor('wallet'),
    registerAuditActions('wallet', WALLET_AUDIT_ACTIONS),
    registerPermissions('wallet', WALLET_PERMISSIONS),
    registerStepUpActions('wallet', WALLET_STEP_UP_ACTIONS),
    ...walletProviders,
    ...[
      GrantCredit,
      PlaceHold,
      CaptureHold,
      ReleaseHold,
      BalanceOf,
      OwnBalanceOf,
      ExpireWalletCredit,
      ViewMyWallet,
      ViewMyHistory,
      ViewWalletSettings,
      SetWalletStatus,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: WALLET_FACADE,
      inject: [GrantCredit, PlaceHold, CaptureHold, ReleaseHold, BalanceOf, OwnBalanceOf],
      useFactory: (
        grant: GrantCredit,
        place: PlaceHold,
        capture: CaptureHold,
        release: ReleaseHold,
        balance: BalanceOf,
        ownBalance: OwnBalanceOf,
      ) => new WalletFacadeImplementation(grant, place, capture, release, balance, ownBalance),
    },
    registerJobsFrom('wallet', [ExpireWalletCredit], (expire: ExpireWalletCredit) => [
      expireWalletCreditJob(expire),
    ]),
  ],
  exports: [WALLET_FACADE],
})
export class WalletModule {}
