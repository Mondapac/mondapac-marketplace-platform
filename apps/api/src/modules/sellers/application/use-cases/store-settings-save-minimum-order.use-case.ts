import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Money, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_STORE_SETTINGS_EDIT } from '../../contracts/permissions';
import { MinimumOrderChanged } from '../../domain/audit';
import { parseMinimumOrder } from '../../domain/minimum-order';
import { SAVE_LIMITS } from '../../domain/rate-limits';
import { logDraftOutcome, reserveRateLimits, sellerActorOf } from '../draft/draft-support';
import {
  ruleOf,
  sameMoney,
  storeSettingsLogger,
  type MinimumOrderSaveDependencies,
  type MinimumOrderSaveFailure,
  type StoreSettingsView,
} from '../store-settings/store-settings';

/** The request as the seller sends it: the version the page read and the new value (or null). */
export interface MinimumOrderSaveInput {
  readonly expectedVersion?: unknown;
  readonly minimumOrder?: unknown;
}

/**
 * `store-settings.save-minimum-order` (design 18 decisions 3, 5, 8): sets or clears (`null`) the
 * seller's minimum order. Rule `permissions [sellers.store-settings.edit]`, approved sellers
 * only. In order: the seller is `ActorContext.sellerId`; the saves limit of 6.5 is reserved; the
 * shape and the value are checked (the amount a safe integer above zero and at most the Market's
 * `minimumOrderMax`, the currency the Market's: `minimum-order.amount` and
 * `minimum-order.currency`; nothing is echoed); one read-write unit reads the profile, refuses a
 * stale `expectedVersion` (`conflict.stale`), writes over that version and records
 * `sellers.minimum-order.changed` with before and after. A save that changes nothing writes and
 * audits nothing. No event: cart and `ordering` read the value live (decision 7).
 */
export class StoreSettingsSaveMinimumOrder extends UseCase<
  MinimumOrderSaveInput,
  StoreSettingsView,
  MinimumOrderSaveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-settings-save-minimum-order',
    rule: { kind: 'permissions', allOf: [SELLERS_STORE_SETTINGS_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MinimumOrderSaveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MinimumOrderSaveInput,
  ): Promise<Result<StoreSettingsView, MinimumOrderSaveFailure>> {
    const result = await this.save(context, input ?? {});
    logDraftOutcome(
      'store-settings-save-minimum-order',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'saved' : result.error.code,
    );
    return result;
  }

  private async save(
    context: CallContext,
    input: MinimumOrderSaveInput,
  ): Promise<Result<StoreSettingsView, MinimumOrderSaveFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, storeProfiles, audit, clock } = this.deps;

    const reserved = await reserveRateLimits(this.deps, context, SAVE_LIMITS, owner.accountId);
    if (!reserved.ok) return reserved;

    const rule = ruleOf(this.deps.minimumOrderPolicy, context);
    if (rule === null) return err({ code: 'sellers.unavailable' });
    const version = input.expectedVersion;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'expectedVersion', code: 'format' }],
      });
    }
    const wanted = parseMinimumOrder(input.minimumOrder, rule);
    if (!wanted.ok) return wanted;

    try {
      return await unitOfWork.run<StoreSettingsView, MinimumOrderSaveFailure>(market, async () => {
        const current = await storeProfiles.find(market, owner.sellerId);
        if (current === null) return err({ code: 'file.not-found' });
        if (!current.approved) return err({ code: 'access.denied' });
        if (current.version !== version) return err({ code: 'conflict.stale' });
        const view = (newVersion: number, minimumOrder: Money | null): StoreSettingsView => ({
          version: newVersion,
          minimumOrder,
          currency: rule.currency,
          maximumAmount: rule.max,
        });
        if (sameMoney(current.minimumOrder, wanted.value)) {
          return ok(view(current.version, current.minimumOrder));
        }
        const newVersion = await storeProfiles.saveMinimumOrder(market, owner.sellerId, {
          expectedVersion: version,
          minimumOrder: wanted.value,
          changedByAccountId: owner.accountId,
          changedAt: clock.now(),
        });
        if (newVersion === null) return err({ code: 'conflict.stale' });
        await audit.record(
          context,
          MinimumOrderChanged.entry(owner.sellerId, {
            before: { minimumOrder: current.minimumOrder },
            after: { minimumOrder: wanted.value },
          }),
        );
        return ok(view(newVersion, wanted.value));
      });
    } catch (error) {
      storeSettingsLogger.error({
        msg: 'sellers.store-settings-save-minimum-order.failed',
        error: error instanceof Error ? error.name : 'unknown',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
  }
}
