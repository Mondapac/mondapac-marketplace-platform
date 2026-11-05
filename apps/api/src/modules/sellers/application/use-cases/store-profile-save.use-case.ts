import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { derivedId } from '../../../../platform/hashing/derived-id';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import { SELLERS_STORE_PROFILE_EDIT } from '../../contracts/permissions';
import { StoreImageChanged, StoreProfileSaved } from '../../domain/audit';
import { StoreProfilePublished } from '../../domain/events';
import { SAVE_LIMITS, STORE_IMAGE_LIMITS } from '../../domain/rate-limits';
import { STORE_IMAGE_KINDS, type StoreImageKind } from '../../domain/store-image';
import { contentOf } from '../../domain/store-profile-content';
import { logDraftOutcome, reserveRateLimits, sellerActorOf } from '../draft/draft-support';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { StoreImageProcessor } from '../ports/store-image-processor';
import type { StoreTextClaimCheck } from '../ports/store-text-claim-check';
import { claimFieldsOf, parseAboutTexts } from '../store-profile/about-input';
import { removeObjects } from '../store-profile/store-image-objects';
import {
  decodeImageData,
  stageStoreImage,
  type StageImageFailure,
  type StagedStoreImage,
} from '../store-profile/stage-store-image';
import {
  loadStoreProfileView,
  storeProfileLogger,
  type StoreProfileReadDependencies,
  type StoreProfileView,
  type StoreProfileWriteFailure,
} from '../store-profile/store-profile';

/** The namespace of a store's profile aggregate id; never changed once events exist. */
const STORE_PROFILE_AGGREGATE_NAMESPACE = 'sellers.store-profile.aggregate.v1';

/**
 * What the seller asks to do with one picture: `undefined` keeps it, `null` removes it, an object
 * with the picture as base64 text sets or replaces it.
 */
export type StoreImageChange = null | { readonly data?: unknown };

/** The request as the seller sends it: the version the page read, the texts and the pictures. */
export interface StoreProfileSaveInput {
  readonly expectedVersion?: unknown;
  readonly about?: unknown;
  readonly logo?: StoreImageChange;
  readonly banner?: StoreImageChange;
}

/** A refused picture names which one it was, so the panel can word it. */
export type StoreProfileSaveFailure =
  | StoreProfileWriteFailure
  | (Exclude<StageImageFailure, { readonly code: 'validation.failed' }> & {
      readonly kind: StoreImageKind;
    });

/** A refusal of one picture, with the kind it belongs to (a body problem already names its path). */
const withKind = (error: StageImageFailure, kind: StoreImageKind): StoreProfileSaveFailure =>
  error.code === 'validation.failed' ? error : { ...error, kind };

export interface StoreProfileSaveDependencies extends StoreProfileReadDependencies {
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly claimCheck: StoreTextClaimCheck;
  readonly imageProcessor: StoreImageProcessor;
  readonly objectStore: ObjectStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

type Written = {
  readonly status: 'saved' | 'unchanged';
  /** The objects of replaced or removed pictures, deleted after the commit. */
  readonly replacedKeys: readonly string[];
};

/**
 * `store-profile.save` (sellers design 3.7, 6.2; the Store profile page's one save bar): the
 * About text of each locale and the logo and banner, saved as ONE versioned unit. Every change
 * is public at once (no review). Rule `permissions [sellers.store-profile.edit]`, approved
 * sellers only. In order: the seller is `ActorContext.sellerId`; the saves limit is reserved,
 * and the picture limit once per picture; the shape is checked (`expectedVersion` a whole number
 * from 0; texts keyed by the Market's locales); each text meets the About rules and carries no
 * certification claim term (`about.claim-term`, fail closed); each picture is decoded and written
 * to the object store (a refused picture is named by its kind and stops the save before anything
 * is current); the content is sealed; then one read-write unit refuses a stale `expectedVersion`
 * (`conflict.stale`), makes each new picture current or removes it, inserts the next revision
 * (a picture change is a new revision, with the text as it is) and records `sellers.store-
 * profile.saved`, `sellers.store-image.changed` and the event `sellers.store-profile-published.v1`.
 * Either every part commits or none does: a failure removes the objects written. A save that
 * changes nothing writes nothing. Nothing of a text or a picture reaches a log, an event or an
 * audit row.
 */
export class StoreProfileSave extends UseCase<
  StoreProfileSaveInput,
  StoreProfileView,
  StoreProfileSaveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.store-profile-save',
    rule: { kind: 'permissions', allOf: [SELLERS_STORE_PROFILE_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StoreProfileSaveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: StoreProfileSaveInput,
  ): Promise<Result<StoreProfileView, StoreProfileSaveFailure>> {
    const result = await this.save(context, input ?? {});
    logDraftOutcome(
      'store-profile-save',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'saved' : result.error.code,
    );
    return result;
  }

  private async save(
    context: CallContext,
    input: StoreProfileSaveInput,
  ): Promise<Result<StoreProfileView, StoreProfileSaveFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;

    const changes = STORE_IMAGE_KINDS.flatMap((kind) =>
      input[kind] === undefined ? [] : [{ kind, change: input[kind] }],
    );
    const reserved = await reserveRateLimits(deps, context, SAVE_LIMITS, owner.accountId);
    if (!reserved.ok) return reserved;
    for (let n = 0; n < changes.length; n++) {
      const picture = await reserveRateLimits(deps, context, STORE_IMAGE_LIMITS, owner.accountId);
      if (!picture.ok) return picture;
    }

    const version = input.expectedVersion;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'expectedVersion', code: 'format' }],
      });
    }
    let locales: Awaited<ReturnType<typeof deps.localesPolicy.locales>>;
    try {
      locales = deps.localesPolicy.locales(market);
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
    const checked = parseAboutTexts(input.about, locales.supportedLocales);
    if (!checked.ok) return checked;
    const texts = checked.value;
    const flagged = await claimFieldsOf(deps.claimCheck, context, texts);
    if (!flagged.ok) return flagged;
    if (flagged.value.length > 0) {
      return err({ code: 'validation.failed', fields: flagged.value });
    }

    // Every picture is decoded before the first object is written: a bad one stops the save cheaply.
    const decoded = new Map<StoreImageKind, Buffer>();
    for (const { kind, change } of changes) {
      if (change === null) continue;
      const bytes = decodeImageData((change as { data?: unknown }).data, `${kind}.data`);
      if (!bytes.ok) {
        return err(withKind(bytes.error, kind));
      }
      decoded.set(kind, bytes.value);
    }
    if (decoded.size > 0) {
      const ready = await this.approved(context, owner.sellerId);
      if (!ready.ok) return ready;
    }

    const content = contentOf(Object.fromEntries(texts));
    let sealed: Awaited<ReturnType<typeof deps.contentSealer.seal>>;
    try {
      sealed = await deps.contentSealer.seal(market, owner.sellerId, content);
    } catch (error) {
      storeProfileLogger.error({
        msg: 'sellers.store-profile-save.seal-failed',
        error: error instanceof Error ? error.name : 'unknown',
        sellerId: owner.sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
    if (!sealed.ok) return err({ code: 'sellers.unavailable' });

    const staged: StagedStoreImage[] = [];
    const written = (): string[] => staged.flatMap((image) => [...image.objectKeys]);
    for (const [kind, bytes] of decoded) {
      const image = await stageStoreImage(deps, owner.sellerId, kind, bytes);
      if (!image.ok) {
        await removeObjects(deps.objectStore, written());
        return err(withKind(image.error, kind));
      }
      staged.push(image.value);
    }
    const removals = changes.filter(({ change }) => change === null).map(({ kind }) => kind);

    const revisionId = deps.ids.next<'StoreProfileRevision'>();
    let outcome: Result<Written, StoreProfileWriteFailure>;
    try {
      outcome = await deps.unitOfWork.run<Written, StoreProfileWriteFailure>(market, async () => {
        const settings = await deps.storeProfiles.find(market, owner.sellerId);
        if (settings === null) return err({ code: 'file.not-found' });
        if (!settings.approved) return err({ code: 'access.denied' });
        const published = await deps.storeContent.published(market, owner.sellerId);
        const current = published?.revisionNo ?? 0;
        if (current !== version) return err({ code: 'conflict.stale' });
        const now = deps.clock.now();

        const replacedKeys: string[] = [];
        let picturesChanged = false;
        for (const image of staged) {
          const replaced = await deps.storeImages.replace(market, owner.sellerId, {
            id: image.imageId,
            kind: image.kind,
            uploaderAccountId: owner.accountId,
            width: image.width,
            height: image.height,
            uploadedBytes: image.uploadedBytes,
            createdAt: now,
            renditions: image.renditions,
          });
          replacedKeys.push(...replaced.objectKeys);
          picturesChanged = true;
          await deps.audit.record(
            context,
            StoreImageChanged.entry(owner.sellerId, {
              before: { imageId: replaced.replacedId },
              after: { kind: image.kind, imageId: image.imageId },
            }),
          );
        }
        for (const kind of removals) {
          const gone = await deps.storeImages.remove(market, owner.sellerId, kind);
          // Removing what is not there is not a change.
          if (gone === null) continue;
          replacedKeys.push(...gone.objectKeys);
          picturesChanged = true;
          await deps.audit.record(
            context,
            StoreImageChanged.entry(owner.sellerId, {
              before: { imageId: gone.imageId },
              after: { kind, imageId: null },
            }),
          );
        }
        const textUnchanged =
          published !== null && published.contentHash === sealed.value.contentHash;
        if (textUnchanged && !picturesChanged) return ok({ status: 'unchanged', replacedKeys: [] });

        // A picture change is a revision too, with the text as it is: one version for the page.
        const outcomeOfPublish = await deps.storeContent.publish(market, owner.sellerId, {
          id: revisionId,
          expectedRevisionNo: current,
          ciphertext: sealed.value.ciphertext,
          schemaVersion: content.schemaVersion,
          contentHash: sealed.value.contentHash,
          authorAccountId: owner.accountId,
          createdAt: now,
        });
        if (outcomeOfPublish === 'stale') return err({ code: 'conflict.stale' });
        if (outcomeOfPublish === 'no-profile') return err({ code: 'file.not-found' });
        await deps.audit.record(
          context,
          StoreProfileSaved.entry(owner.sellerId, {
            after: { revisionId, revisionNo: current + 1 },
          }),
        );
        await deps.outbox.append(context, [
          StoreProfilePublished.record({
            // A stable store-profile id derived from the seller id (never the seller id itself).
            aggregateId: derivedId<'StoreProfile'>(
              STORE_PROFILE_AGGREGATE_NAMESPACE,
              owner.sellerId,
            ),
            aggregateVersion: current + 1,
            occurredAt: now,
            payload: { sellerId: owner.sellerId, revisionId },
          }),
        ]);
        return ok({ status: 'saved', replacedKeys });
      });
    } catch (error) {
      storeProfileLogger.error({
        msg: 'sellers.store-profile-save.failed',
        error: error instanceof Error ? error.name : 'unknown',
        sellerId: owner.sellerId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      await removeObjects(deps.objectStore, written());
      return err({ code: 'sellers.unavailable' });
    }
    if (!outcome.ok) {
      await removeObjects(deps.objectStore, written());
      return outcome;
    }
    // Nothing committed: the new pictures were never current. Otherwise the old objects go after
    // the commit; a failed delete leaves an unreachable object only.
    if (outcome.value.status === 'unchanged') await removeObjects(deps.objectStore, written());
    else await removeObjects(deps.objectStore, outcome.value.replacedKeys);
    return loadStoreProfileView(deps, context, owner);
  }

  /** The seller's file is approved, read before any picture is written (a pending seller costs no CPU). */
  private async approved(
    context: CallContext,
    sellerId: Parameters<StoreProfileReadDependencies['storeProfiles']['find']>[1],
  ): Promise<Result<true, StoreProfileWriteFailure>> {
    const { market } = context;
    try {
      return await this.deps.unitOfWork.run<true, StoreProfileWriteFailure>(
        market,
        async () => {
          const settings = await this.deps.storeProfiles.find(market, sellerId);
          if (settings === null) return err({ code: 'file.not-found' });
          return settings.approved ? ok(true) : err({ code: 'access.denied' });
        },
        { readOnly: true },
      );
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
