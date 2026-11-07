import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_IMPORT_RUN, CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { IMPORT_PHOTO_LIMITS } from '../../domain/rate-limits';
import { photoKeyOf } from '../../domain/seller-import/row-check';
import { draftContentOfRevision } from '../../domain/seller-import/merge-import-row';
import { isActingAsSession } from '../acting-as';
import { reserveForAccount, type ReserveFailure } from '../platform-import/reserve';
import type { ProductImageView } from '../images/own-product-access';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { SellerImportRepository } from '../ports/seller-import.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import type { SaveDraft, SaveDraftFailure } from '../working-copy/save-draft.service';
import {
  photoWindowOpen,
  sellerImportIdOf,
  type SellerImportCommonFailure,
} from '../seller-import/seller-import-support';
import type {
  OwnProductImageUpload,
  OwnProductImageUploadFailure,
} from './own-product-image-upload.use-case';

export interface OwnImportAddPhotoInput {
  readonly importId: unknown;
  /** The photo's name as the file lists it (a file name); matched without case. */
  readonly name: unknown;
  /** The photo as standard base64 text. */
  readonly data: unknown;
}

export interface OwnImportAddPhotoOutput {
  readonly productId: string;
  readonly image: ProductImageView;
}

export type OwnImportAddPhotoFailure =
  | SellerImportCommonFailure
  | OwnProductImageUploadFailure
  | ReserveFailure
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'import.photos-closed' }
  | { readonly code: 'import.photo-not-named' }
  | { readonly code: 'import.photo-already-added' }
  | AccessDenied
  | SaveDraftFailure;

export interface OwnImportAddPhotoDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerJobs: SellerImportRepository;
  readonly products: ProductRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly revisions: ProductRevisionRepository;
  readonly saveDraft: SaveDraft;
  /** `own-product.upload-image` built without the interactive save budget. */
  readonly ownImageUpload: OwnProductImageUpload;
  readonly eligibility: SellerEligibilityReader;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

/**
 * The key of a photo name: the file label cleaning and lower case, the same on the file's side (the
 * names a row lists) and on the request's, so a name matches exactly when the file listed it.
 */
export function photoNameKey(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') return null;
  const key = photoKeyOf(name);
  return key.length >= 1 && key.length <= 80 ? key : null;
}

/** A reservation with no image after this long is the leftover of a crash and may be taken over. */
const RESERVATION_STALE_SECONDS = 600;

const BASE64_HEAD = /^[A-Za-z0-9+/]/;

/**
 * `own-import.add-photo` (catalog design 14c, "The photo step"): after a `my-products` import ended,
 * the seller adds the photos its rows named, one at a time, for seven days. The server never opens a
 * ZIP and never fetches a link: each call carries one photo and the name the file listed. The
 * product comes **from the job's row record**, never from the request; a name no group of this job
 * listed is `import.photo-not-named`, a name already added is `import.photo-already-added`. The
 * photo goes through `own-product.upload-image` (three metadata-free renditions, eight per product)
 * and its id is appended to the product's draft `imageIds`; the interactive save budget is not
 * spent, and the import's own photo limits (60 a minute and 2,000 a day) bound the step. Rule: the
 * keys `catalog.own-import.run` and `catalog.own-product.edit`; an acting-as session is refused.
 */
export class OwnImportAddPhoto extends UseCase<
  OwnImportAddPhotoInput,
  OwnImportAddPhotoOutput,
  OwnImportAddPhotoFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-add-photo',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_OWN_IMPORT_RUN.key, CATALOG_OWN_PRODUCT_EDIT.key],
    },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnImportAddPhoto');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportAddPhotoDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnImportAddPhotoInput,
  ): Promise<Result<OwnImportAddPhotoOutput, OwnImportAddPhotoFailure>> {
    const result = await this.#add(context, input);
    this.#logger.log({
      msg: 'catalog.own-import-add-photo',
      code: result.ok ? 'added' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #add(
    context: CallContext,
    input: OwnImportAddPhotoInput,
  ): Promise<Result<OwnImportAddPhotoOutput, OwnImportAddPhotoFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    if (isActingAsSession(actor)) return err({ code: 'access.acting-as-refused' });
    const sellerId = actor.sellerId;
    const { deps } = this;
    const fail = (path: string, code: string): Result<never, OwnImportAddPhotoFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const importId = sellerImportIdOf(input.importId);
    if (importId === null) return fail('importId', 'format');
    const nameKey = photoNameKey(input.name);
    if (nameKey === null) return fail('name', 'format');
    if (typeof input.data !== 'string' || !BASE64_HEAD.test(input.data)) {
      return fail('data', 'required');
    }
    if (!(await deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const now = deps.clock.now();

    // Who and what, before any photo work: the job is the account's own, the window is open, the
    // name was listed by a group of this job and has no photo yet.
    const read = await deps.unitOfWork.run<string, OwnImportAddPhotoFailure>(
      market,
      async () => {
        const job = await deps.sellerJobs.find(market, sellerId, importId);
        if (job === null || job.startedByAccountId !== actor.accountId) {
          return err({ code: 'import.not-found' } as const);
        }
        if (!photoWindowOpen(job, now)) return err({ code: 'import.photos-closed' } as const);
        const target = await deps.sellerJobs.photoTarget(market, importId, nameKey);
        if (target === null) return err({ code: 'import.photo-not-named' } as const);
        if ((await deps.sellerJobs.photoNames(market, importId)).has(nameKey)) {
          return err({ code: 'import.photo-already-added' } as const);
        }
        return ok(target);
      },
      { readOnly: true },
    );
    if (!read.ok) {
      return read.error.code === 'access.denied' ? err({ code: 'access.unavailable' }) : read;
    }
    const productId = parseId<'Product'>(read.value);
    if (!productId.ok) return err({ code: 'access.unavailable' });

    // The name is reserved before any photo work, in a unit of its own, so a second request for the
    // same name stops here and never uploads a second image; any failure below drops the reservation.
    const reserved = await deps.unitOfWork.run(market, async () =>
      ok(
        await deps.sellerJobs.reservePhoto(
          market,
          { jobId: importId, nameKey, productId: productId.value, addedAt: now },
          now.subtract({ seconds: RESERVATION_STALE_SECONDS }),
        ),
      ),
    );
    if (!reserved.ok) return err({ code: 'access.unavailable' });
    if (!reserved.value) return err({ code: 'import.photo-already-added' });

    const release = async (): Promise<void> => {
      await deps.unitOfWork
        .run(market, async () => ok(await deps.sellerJobs.releasePhoto(market, importId, nameKey)))
        .catch(() => undefined);
    };
    try {
      const added = await this.#upload(
        context,
        sellerId,
        productId.value,
        importId,
        nameKey,
        input.data,
      );
      if (!added.ok) await release();
      return added;
    } catch (error) {
      await release();
      throw error;
    }
  }

  /** The upload, the draft save and the image id of the reserved name. */
  async #upload(
    context: CallContext,
    sellerId: Id<'Seller'>,
    productId: Id<'Product'>,
    importId: Id<'SellerImport'>,
    nameKey: string,
    data: string,
  ): Promise<Result<OwnImportAddPhotoOutput, OwnImportAddPhotoFailure>> {
    const { market } = context;
    const { deps } = this;
    const throttled = await reserveForAccount(deps, context, IMPORT_PHOTO_LIMITS, sellerId);
    if (throttled !== null) return err(throttled);

    const uploaded = await deps.ownImageUpload.execute(context, { productId, data });
    if (!uploaded.ok) return err(uploaded.error);

    // The photo joins the draft's gallery; the seller submits as ever.
    const base = await deps.unitOfWork.run(
      market,
      async () => {
        const product = await deps.products.findById(market, productId);
        if (product === null || product.state.ownerSellerId !== sellerId) {
          return ok(null);
        }
        const stored = await deps.workingCopies.find(market, productId);
        let content: Readonly<Record<string, unknown>> = stored?.content ?? {};
        if (stored === null && product.state.publishedRevisionId !== null) {
          const revision = await deps.revisions.find(
            market,
            productId,
            product.state.publishedRevisionId,
          );
          if (revision !== null) content = draftContentOfRevision(revision.content);
        }
        return ok({ content, variantIds: product.liveVariants.map((v) => v.id) });
      },
      { readOnly: true },
    );
    if (!base.ok || base.value === null) return err({ code: 'product.not-found' });
    const imageIds = Array.isArray(base.value.content['imageIds'])
      ? (base.value.content['imageIds'] as string[])
      : [];
    const saved = await deps.saveDraft.execute(
      context,
      {
        productId,
        content: { ...base.value.content, imageIds: [...imageIds, uploaded.value.imageId] },
        variantIds: base.value.variantIds,
      },
      { spendSavesLimit: false },
    );
    if (!saved.ok) return err(saved.error);

    const recorded = await deps.unitOfWork.run(market, async () =>
      ok(await deps.sellerJobs.setPhotoImage(market, importId, nameKey, uploaded.value.imageId)),
    );
    if (!recorded.ok || !recorded.value) return err({ code: 'access.unavailable' });
    return ok({ productId, image: uploaded.value });
  }
}
