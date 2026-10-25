import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_STORE_SETTINGS_EDIT } from '../../contracts/permissions';
import { DeliveryTermsChanged } from '../../domain/audit';
import { parseDeliveryTerms, sameTerms, type DeliveryTerms } from '../../domain/delivery-terms';
import { SAVE_LIMITS } from '../../domain/rate-limits';
import { logDraftOutcome, reserveRateLimits, sellerActorOf } from '../draft/draft-support';
import {
  ruleOf,
  storeSettingsLogger,
  type DeliverySaveFailure,
  type MinimumOrderSaveDependencies,
  type StoreSettingsView,
} from '../store-settings/store-settings';

/** The request as the seller sends it: the version the page read and the new terms (or null). */
export interface DeliverySaveInput {
  readonly expectedVersion?: unknown;
  readonly delivery?: unknown;
}

const auditSide = (terms: DeliveryTerms | null) => ({
  day: terms?.day ?? null,
  fromMinute: terms?.fromMinute ?? null,
  toMinute: terms?.toMinute ?? null,
  cutoffMinute: terms?.cutoffMinute ?? null,
});

/**
 * `store-settings.save-delivery` (package e): sets or clears (`null`) the seller's delivery terms:
 * the day, the window and the daily order cut-off, as clock times in the seller's own zone. Rule
 * `permissions [sellers.store-settings.edit]`, approved sellers only, like the minimum order. In
 * order: the seller is `ActorContext.sellerId`; the saves limit is reserved; the shape and the
 * values are checked (`delivery.day`, `delivery.window`, `delivery.cutoff`; nothing is echoed); one
 * read-write unit reads the profile, refuses a stale `expectedVersion` (`conflict.stale`), writes
 * over that version and records `sellers.delivery-terms.changed` with before and after. A save that
 * changes nothing writes and audits nothing. No event: the store page reads the value live.
 */
export class StoreSettingsSaveDelivery extends UseCase<
  DeliverySaveInput,
  StoreSettingsView,
  DeliverySaveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-settings-save-delivery',
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
    input: DeliverySaveInput,
  ): Promise<Result<StoreSettingsView, DeliverySaveFailure>> {
    const result = await this.save(context, input ?? {});
    logDraftOutcome(
      'store-settings-save-delivery',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'saved' : result.error.code,
    );
    return result;
  }

  private async save(
    context: CallContext,
    input: DeliverySaveInput,
  ): Promise<Result<StoreSettingsView, DeliverySaveFailure>> {
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
    const wanted = parseDeliveryTerms(input.delivery);
    if (!wanted.ok) return wanted;

    try {
      return await unitOfWork.run<StoreSettingsView, DeliverySaveFailure>(market, async () => {
        const current = await storeProfiles.find(market, owner.sellerId);
        if (current === null) return err({ code: 'file.not-found' });
        if (!current.approved) return err({ code: 'access.denied' });
        if (current.version !== version) return err({ code: 'conflict.stale' });
        const view = (newVersion: number, delivery: DeliveryTerms | null): StoreSettingsView => ({
          version: newVersion,
          minimumOrder: current.minimumOrder,
          currency: rule.currency,
          maximumAmount: rule.max,
          delivery,
        });
        if (sameTerms(current.delivery, wanted.value)) {
          return ok(view(current.version, current.delivery));
        }
        const newVersion = await storeProfiles.saveDeliveryTerms(market, owner.sellerId, {
          expectedVersion: version,
          delivery: wanted.value,
          changedByAccountId: owner.accountId,
          changedAt: clock.now(),
        });
        if (newVersion === null) return err({ code: 'conflict.stale' });
        await audit.record(
          context,
          DeliveryTermsChanged.entry(owner.sellerId, {
            before: auditSide(current.delivery),
            after: auditSide(wanted.value),
          }),
        );
        return ok(view(newVersion, wanted.value));
      });
    } catch (error) {
      storeSettingsLogger.error({
        msg: 'sellers.store-settings-save-delivery.failed',
        error: error instanceof Error ? error.name : 'unknown',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
  }
}
