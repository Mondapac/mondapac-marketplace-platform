import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type {
  ChangeHistoryFailure,
  ChangeHistoryInput,
  ChangeHistoryPage,
} from '../../../../platform/audit/change-trail';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_SETTINGS_VIEW } from '../../contracts/permissions';
import { WALLET_SETTINGS_CHANGES } from '../settings-flow';
import type { WalletDependencies } from '../wallet-dependencies';

/**
 * `wallet.view-wallet-settings-history`: the changes of the Market's wallet switch, newest first,
 * from the `wallet.market-status.changed` audit rows: when, who (a display name) and the names of
 * the fields that changed (status, reason), never a value and never the step-up proof. Same gate
 * as the page.
 */
export class ViewWalletSettingsHistory extends UseCase<
  ChangeHistoryInput,
  ChangeHistoryPage,
  ChangeHistoryFailure | { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.view-wallet-settings-history',
    rule: { kind: 'permissions', allOf: [WALLET_SETTINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ChangeHistoryInput,
  ): Promise<Result<ChangeHistoryPage, ChangeHistoryFailure | { readonly code: 'access.denied' }>> {
    // As the page it explains: an admin session only, whatever keys another population holds.
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' } as const));
    }
    return this.deps.trail.history(context, WALLET_SETTINGS_CHANGES, input ?? {});
  }
}
