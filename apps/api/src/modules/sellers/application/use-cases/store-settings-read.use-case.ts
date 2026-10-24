import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_STORE_SETTINGS_EDIT } from '../../contracts/permissions';
import { logDraftOutcome, sellerActorOf } from '../draft/draft-support';
import {
  ruleOf,
  storeSettingsLogger,
  type StoreSettingsDependencies,
  type StoreSettingsFailure,
  type StoreSettingsView,
} from '../store-settings/store-settings';

export type { StoreSettingsView };

/**
 * `store-settings.read` (design 18 decision 5): the seller's own settings. Rule `permissions
 * [sellers.store-settings.edit]`, approved sellers only: a seller without an approved revision
 * gets `access.denied`, as does any actor that is not a seller of this Market.
 */
export class StoreSettingsRead extends UseCase<
  Record<string, never>,
  StoreSettingsView,
  StoreSettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-settings-read',
    rule: { kind: 'permissions', allOf: [SELLERS_STORE_SETTINGS_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StoreSettingsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<StoreSettingsView, StoreSettingsFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const rule = ruleOf(this.deps.minimumOrderPolicy, context);
    if (rule === null) return err({ code: 'sellers.unavailable' });
    try {
      const read = await this.deps.unitOfWork.run<StoreSettingsView, StoreSettingsFailure>(
        context.market,
        async () => {
          const settings = await this.deps.storeProfiles.find(context.market, owner.sellerId);
          if (settings === null) return err({ code: 'file.not-found' });
          if (!settings.approved) return err({ code: 'access.denied' });
          return ok({
            version: settings.version,
            minimumOrder: settings.minimumOrder,
            currency: rule.currency,
            maximumAmount: rule.max,
            delivery: settings.delivery,
          });
        },
        { readOnly: true },
      );
      logDraftOutcome(
        'store-settings-read',
        context,
        owner.sellerId,
        read.ok ? 'read' : read.error.code,
      );
      return read;
    } catch (error) {
      storeSettingsLogger.error({
        msg: 'sellers.store-settings-read.failed',
        error: error instanceof Error ? error.name : 'unknown',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
  }
}
