import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_STORE_PROFILE_VIEW } from '../../contracts/permissions';
import { isStoreImageSize } from '../../domain/store-image';
import { logDraftOutcome, sellerActorOf } from '../draft/draft-support';
import type { StoreImageRepository } from '../ports/store-image.repository';
import type { StoreProfileRepository } from '../ports/store-profile.repository';
import { storeProfileLogger, type StoreProfileFailure } from '../store-profile/store-profile';

export interface StoreImageReadOwnInput {
  readonly imageId?: unknown;
  readonly size?: unknown;
}

/** The bytes of one rendition, written by this server: always a JPEG. */
export interface StoreImageBytes {
  readonly bytes: Buffer;
  readonly contentType: 'image/jpeg';
}

export type StoreImageReadFailure = StoreProfileFailure | { readonly code: 'image.not-found' };

export interface StoreImageReadOwnDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly storeProfiles: StoreProfileRepository;
  readonly storeImages: StoreImageRepository;
  readonly objectStore: ObjectStore;
}

/**
 * `store-image.read-own` (slice 12 part 2): the seller's own logo or banner for the panel's
 * preview. Rule `permissions [sellers.store-profile.view]`, approved sellers only. Only the
 * seller's current image answers; a replaced, removed, unknown or another seller's id is the same
 * `image.not-found`. The size is `small` or `large`.
 */
export class StoreImageReadOwn extends UseCase<
  StoreImageReadOwnInput,
  StoreImageBytes,
  StoreImageReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-image-read-own',
    rule: { kind: 'permissions', allOf: [SELLERS_STORE_PROFILE_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StoreImageReadOwnDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: StoreImageReadOwnInput,
  ): Promise<Result<StoreImageBytes, StoreImageReadFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const result = await this.read(context, owner.sellerId, input ?? {});
    logDraftOutcome(
      'store-image-read-own',
      context,
      owner.sellerId,
      result.ok ? 'read' : result.error.code,
    );
    return result;
  }

  private async read(
    context: CallContext,
    sellerId: Parameters<StoreImageRepository['findCurrent']>[1],
    input: StoreImageReadOwnInput,
  ): Promise<Result<StoreImageBytes, StoreImageReadFailure>> {
    const notFound = err({ code: 'image.not-found' } as const);
    const imageId = typeof input.imageId === 'string' ? parseId<'StoreImage'>(input.imageId) : null;
    if (imageId === null || !imageId.ok || !isStoreImageSize(input.size)) return notFound;
    const { market } = context;
    const { size } = input;
    try {
      const found = await this.deps.unitOfWork.run<
        Awaited<ReturnType<StoreImageRepository['findCurrent']>>,
        StoreProfileFailure
      >(
        market,
        async () => {
          const settings = await this.deps.storeProfiles.find(market, sellerId);
          if (settings === null) return err({ code: 'file.not-found' });
          if (!settings.approved) return err({ code: 'access.denied' });
          return ok(await this.deps.storeImages.findCurrent(market, sellerId, imageId.value));
        },
        { readOnly: true },
      );
      if (!found.ok) return found;
      const rendition = found.value?.renditions.find((candidate) => candidate.size === size);
      if (rendition === undefined) return notFound;
      const bytes = await this.deps.objectStore.get(rendition.objectKey);
      if (bytes === null) {
        storeProfileLogger.error({
          msg: 'sellers.store-image-read-own.object-missing',
          sellerId,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        return err({ code: 'sellers.unavailable' });
      }
      return ok({ bytes, contentType: 'image/jpeg' });
    } catch (error) {
      storeProfileLogger.error({
        msg: 'sellers.store-image-read-own.failed',
        error: error instanceof Error ? error.name : 'unknown',
        sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
  }
}
