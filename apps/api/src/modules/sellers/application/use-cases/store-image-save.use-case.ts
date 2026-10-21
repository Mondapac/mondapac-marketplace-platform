import { createHash } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { IMAGE_BUSY_RETRY_SECONDS } from '../../../../platform/images/image-pipeline';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import { SELLERS_STORE_PROFILE_EDIT } from '../../contracts/permissions';
import { StoreImageChanged } from '../../domain/audit';
import { STORE_IMAGE_LIMITS } from '../../domain/rate-limits';
import {
  isStoreImageKind,
  STORE_IMAGE_MAX_UPLOAD_BYTES,
  type StoreImageKind,
} from '../../domain/store-image';
import { logDraftOutcome, reserveRateLimits, sellerActorOf } from '../draft/draft-support';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { StoreImageProcessor, StoreImageRefusalCode } from '../ports/store-image-processor';
import type { StoredStoreRendition } from '../ports/store-image.repository';
import {
  loadStoreProfileView,
  storeProfileLogger,
  type StoreProfileReadDependencies,
  type StoreProfileView,
  type StoreProfileWriteFailure,
} from '../store-profile/store-profile';
import { removeObjects, storeImageObjectKey } from '../store-profile/store-image-objects';

export interface StoreImageSaveInput {
  readonly kind?: unknown;
  /** The picture as standard base64 text; the type comes from the decoded content. */
  readonly data?: unknown;
}

export type StoreImageSaveFailure =
  | StoreProfileWriteFailure
  | { readonly code: Exclude<StoreImageRefusalCode, 'file.busy'> }
  | { readonly code: 'access.unavailable'; readonly retryAfterSeconds: number };

export interface StoreImageSaveDependencies extends StoreProfileReadDependencies {
  readonly imageProcessor: StoreImageProcessor;
  readonly objectStore: ObjectStore;
  readonly audit: AuditWriter;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * `store-image.save` (sellers design 3.7, 6.2 `my-store-profile.save`; slice 12 part 2): sets or
 * replaces the logo or the banner. The picture is decoded and written again as two metadata-free
 * JPEG renditions; the raw upload is never stored. Rule `permissions [sellers.store-profile.edit]`,
 * approved sellers only. In order: the seller is `ActorContext.sellerId`; the saves limit of 6.5
 * is reserved; the kind and the base64 text are checked (at most 4 MiB of bytes); the seller's
 * file is checked as approved before any decoding; the picture is processed (type by content, a
 * bounded pixel count, no animation, orientation applied; `file.too-small`, `file.too-large`,
 * `file.too-many-pixels`, `file.unsupported-type`, `file.unreadable`); the renditions are written
 * to the object store under keys the code builds; one read-write unit makes the new image the
 * current one of its kind (deleting the old row) and records `sellers.store-image.changed`; the old
 * objects are deleted after the commit. Any failure removes the objects written.
 */
export class StoreImageSave extends UseCase<
  StoreImageSaveInput,
  StoreProfileView,
  StoreImageSaveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-image-save',
    rule: { kind: 'permissions', allOf: [SELLERS_STORE_PROFILE_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StoreImageSaveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: StoreImageSaveInput,
  ): Promise<Result<StoreProfileView, StoreImageSaveFailure>> {
    const result = await this.save(context, input ?? {});
    logDraftOutcome(
      'store-image-save',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'saved' : result.error.code,
    );
    return result;
  }

  private async save(
    context: CallContext,
    input: StoreImageSaveInput,
  ): Promise<Result<StoreProfileView, StoreImageSaveFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    const fail = (path: string, code: string): Result<never, StoreImageSaveFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });

    const reserved = await reserveRateLimits(deps, context, STORE_IMAGE_LIMITS, owner.accountId);
    if (!reserved.ok) return reserved;

    const kind = input.kind;
    if (!isStoreImageKind(kind)) return fail('kind', 'format');
    const data = input.data;
    if (typeof data !== 'string' || data.length === 0) return fail('data', 'required');
    if (data.length > Math.ceil((STORE_IMAGE_MAX_UPLOAD_BYTES * 4) / 3) + 4) {
      return err({ code: 'file.too-large' });
    }
    if (data.length % 4 !== 0 || !BASE64.test(data)) return fail('data', 'format');

    const ready = await this.approved(context, owner.sellerId);
    if (!ready.ok) return ready;

    const bytes = Buffer.from(data, 'base64');
    const processed = await deps.imageProcessor.process(kind, bytes);
    if (!processed.ok) {
      // Too many pictures are in flight: a 503 with a short wait, before anything is stored.
      return processed.error.code === 'file.busy'
        ? err({ code: 'access.unavailable', retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS })
        : err({ code: processed.error.code });
    }

    const imageId = deps.ids.next<'StoreImage'>();
    const renditions: StoredStoreRendition[] = [];
    const stored: string[] = [];
    try {
      for (const rendition of processed.value) {
        const objectKey = storeImageObjectKey(owner.sellerId, imageId, rendition.size);
        await deps.objectStore.put(objectKey, rendition.bytes);
        stored.push(objectKey);
        renditions.push({
          size: rendition.size,
          objectKey,
          sha256: createHash('sha256').update(rendition.bytes).digest(),
          byteSize: rendition.bytes.length,
          width: rendition.width,
          height: rendition.height,
        });
      }
    } catch {
      await removeObjects(deps.objectStore, stored);
      return err({ code: 'access.unavailable' });
    }
    const largest = renditions[0]!;
    let outcome: Result<readonly string[], StoreImageSaveFailure>;
    try {
      outcome = await deps.unitOfWork.run<readonly string[], StoreImageSaveFailure>(
        market,
        async () => {
          const settings = await deps.storeProfiles.find(market, owner.sellerId);
          if (settings === null) return err({ code: 'file.not-found' });
          if (!settings.approved) return err({ code: 'access.denied' });
          const replaced = await deps.storeImages.replace(market, owner.sellerId, {
            id: imageId,
            kind,
            uploaderAccountId: owner.accountId,
            width: largest.width,
            height: largest.height,
            uploadedBytes: bytes.length,
            createdAt: deps.clock.now(),
            renditions,
          });
          await deps.audit.record(
            context,
            StoreImageChanged.entry(owner.sellerId, {
              before: { imageId: replaced.replacedId },
              after: { kind, imageId },
            }),
          );
          return ok(replaced.objectKeys);
        },
      );
    } catch (error) {
      storeProfileLogger.error({
        msg: 'sellers.store-image-save.failed',
        error: error instanceof Error ? error.name : 'unknown',
        sellerId: owner.sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      await removeObjects(deps.objectStore, stored);
      return err({ code: 'sellers.unavailable' });
    }
    if (!outcome.ok) {
      await removeObjects(deps.objectStore, stored);
      return outcome;
    }
    // The old objects go after the commit; a failed delete leaves an unreachable object only.
    await removeObjects(deps.objectStore, outcome.value);
    return loadStoreProfileView(deps, context, owner);
  }

  /** The seller's file is approved, read before any decoding (a pending seller costs no CPU). */
  private async approved(
    context: CallContext,
    sellerId: Parameters<StoreProfileReadDependencies['storeProfiles']['find']>[1],
  ): Promise<Result<true, StoreImageSaveFailure>> {
    const { market } = context;
    try {
      const read = await this.deps.unitOfWork.run<true, StoreImageSaveFailure>(
        market,
        async () => {
          const settings = await this.deps.storeProfiles.find(market, sellerId);
          if (settings === null) return err({ code: 'file.not-found' });
          return settings.approved ? ok(true) : err({ code: 'access.denied' });
        },
        { readOnly: true },
      );
      return read;
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}

export type { StoreImageKind };
