import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import { SELLERS_STORE_PROFILE_EDIT } from '../../contracts/permissions';
import { StoreImageChanged } from '../../domain/audit';
import { STORE_IMAGE_LIMITS } from '../../domain/rate-limits';
import { isStoreImageKind } from '../../domain/store-image';
import { logDraftOutcome, reserveRateLimits, sellerActorOf } from '../draft/draft-support';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import { removeObjects } from '../store-profile/store-image-objects';
import {
  loadStoreProfileView,
  storeProfileLogger,
  type StoreProfileReadDependencies,
  type StoreProfileView,
  type StoreProfileWriteFailure,
} from '../store-profile/store-profile';

export interface StoreImageRemoveInput {
  readonly kind?: unknown;
}

export interface StoreImageRemoveDependencies extends StoreProfileReadDependencies {
  readonly objectStore: ObjectStore;
  readonly audit: AuditWriter;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

/**
 * `store-image.remove` (sellers design 3.7; slice 12 part 2): takes the logo or the banner off the
 * store. Rule `permissions [sellers.store-profile.edit]`, approved sellers only. The saves limit of
 * 6.5 is reserved; one read-write unit deletes the row (so the image can no longer be served from
 * that moment) and records `sellers.store-image.changed`; the objects are deleted after the commit.
 * Removing what is not there is not an error: the answer is the profile as it is, and nothing is
 * audited.
 */
export class StoreImageRemove extends UseCase<
  StoreImageRemoveInput,
  StoreProfileView,
  StoreProfileWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-image-remove',
    rule: { kind: 'permissions', allOf: [SELLERS_STORE_PROFILE_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StoreImageRemoveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: StoreImageRemoveInput,
  ): Promise<Result<StoreProfileView, StoreProfileWriteFailure>> {
    const result = await this.remove(context, input ?? {});
    logDraftOutcome(
      'store-image-remove',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'removed' : result.error.code,
    );
    return result;
  }

  private async remove(
    context: CallContext,
    input: StoreImageRemoveInput,
  ): Promise<Result<StoreProfileView, StoreProfileWriteFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;

    const reserved = await reserveRateLimits(deps, context, STORE_IMAGE_LIMITS, owner.accountId);
    if (!reserved.ok) return reserved;
    const kind = input.kind;
    if (!isStoreImageKind(kind)) {
      return err({ code: 'validation.failed', fields: [{ path: 'kind', code: 'format' }] });
    }

    let keys: readonly string[];
    try {
      const removed = await deps.unitOfWork.run<readonly string[], StoreProfileWriteFailure>(
        market,
        async () => {
          const settings = await deps.storeProfiles.find(market, owner.sellerId);
          if (settings === null) return err({ code: 'file.not-found' });
          if (!settings.approved) return err({ code: 'access.denied' });
          const gone = await deps.storeImages.remove(market, owner.sellerId, kind);
          if (gone === null) return ok([]);
          await deps.audit.record(
            context,
            StoreImageChanged.entry(owner.sellerId, {
              before: { imageId: gone.imageId },
              after: { kind, imageId: null },
            }),
          );
          return ok(gone.objectKeys);
        },
      );
      if (!removed.ok) return removed;
      keys = removed.value;
    } catch (error) {
      storeProfileLogger.error({
        msg: 'sellers.store-image-remove.failed',
        error: error instanceof Error ? error.name : 'unknown',
        sellerId: owner.sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
    await removeObjects(deps.objectStore, keys);
    return loadStoreProfileView(deps, context, owner);
  }
}
