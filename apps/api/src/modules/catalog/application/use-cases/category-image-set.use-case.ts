import { createHash } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { IMAGE_BUSY_RETRY_SECONDS } from '../../../../platform/images/image-pipeline';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import { PlatformCategoryImageChangedAudit } from '../../domain/audit';
import { isEditable } from '../../domain/category-edit';
import {
  categoryImageLogger,
  removeObjects,
  type CategoryImageWriteDependencies,
  type CategoryImageWriteFailure,
  type CategoryImageWriteView,
} from '../categories/category-image';
import {
  announceChanged,
  categoryIdOf,
  closedInput,
  editorAccountOf,
  invalid,
  versionOf,
} from '../categories/category-editor';
import { MAX_UPLOAD_BYTES } from '../images/image-limits';
import {
  categoryImageObjectKey,
  type StoredCategoryRendition,
} from '../ports/category-image.store';

/** The answer of the unit and the files it took out of use. */
interface Written {
  readonly view: CategoryImageWriteView;
  readonly oldKeys: readonly string[];
}

export interface CategoryImageSetInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'version', 'data'] as const;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * `platform-category.set-image` (categories package C3c; plan section 4 "Image / Icon"): an admin
 * sets or replaces the image of an active or hidden category. The picture goes through the product
 * image pipeline: decoded (JPEG, PNG or WebP by content, a bounded pixel count, no animation) and
 * written again as three metadata-free JPEG renditions under keys the code builds; the upload
 * itself is never stored. The request names the category version the admin saw (a later one is
 * `conflict.stale`); the category is read before any decoding, so a stale or unknown category
 * costs no CPU. One unit makes the new image the category's image, deletes the old row, raises the
 * category version, records `catalog.platform-category.image-changed` and announces
 * `catalog.platform-category-changed.v1`; the old files go after the commit, and any failure
 * removes the files written. Not a structural change (no tree version) and no revision: "Use this
 * version again" covers names and texts only. A category of another Market is not found. Rule: the
 * key `catalog.category-tree.edit`; refused in an acting-as session.
 */
export class CategoryImageSet extends UseCase<
  CategoryImageSetInput,
  CategoryImageWriteView,
  CategoryImageWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-image-set',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryImageWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryImageSetInput,
  ): Promise<Result<CategoryImageWriteView, CategoryImageWriteFailure>> {
    const result = await this.#set(context, input);
    categoryImageLogger.log({
      msg: 'catalog.category-image-set',
      code: result.ok ? 'set' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #set(
    context: CallContext,
    input: CategoryImageSetInput,
  ): Promise<Result<CategoryImageWriteView, CategoryImageWriteFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return err({ code: 'category.not-found' });
    const version = versionOf(body.value['version'], 'version');
    if (!version.ok) return version;
    const data = body.value['data'];
    if (typeof data !== 'string' || data.length === 0) return invalid('data', 'required');
    if (data.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) {
      return err({ code: 'file.too-large' });
    }
    if (data.length % 4 !== 0 || !BASE64.test(data)) return invalid('data', 'format');

    const { market } = context;
    const { deps } = this;
    // The category first, read only: an unknown, archived or stale one costs no decoding.
    let first: Result<true, CategoryImageWriteFailure>;
    try {
      first = await deps.unitOfWork.run<true, CategoryImageWriteFailure>(
        market,
        async () => {
          const owner = await deps.categoryImages.owner(market, id.value);
          if (owner === null) return err({ code: 'category.not-found' });
          if (!isEditable(owner.status)) return err({ code: 'category.not-editable' });
          if (owner.version !== version.value) return err({ code: 'conflict.stale' });
          return ok(true);
        },
        { readOnly: true },
      );
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (!first.ok) return first;

    const bytes = Buffer.from(data, 'base64');
    const processed = await deps.imageProcessor.process(bytes);
    if (!processed.ok) {
      // Too many pictures are in flight: the same 503 as a store fault, with a short wait.
      return processed.error.code === 'file.busy'
        ? err({ code: 'access.unavailable', retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS })
        : err({ code: processed.error.code });
    }

    const imageId = deps.ids.next<'CategoryImage'>();
    const renditions: StoredCategoryRendition[] = [];
    const stored: string[] = [];
    try {
      for (const rendition of processed.value) {
        const objectKey = categoryImageObjectKey(id.value, imageId, rendition.size);
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
    const largest = renditions[renditions.length - 1];
    if (largest === undefined) {
      await removeObjects(deps.objectStore, stored);
      return err({ code: 'file.unreadable' });
    }

    let outcome: Result<Written, CategoryImageWriteFailure>;
    try {
      outcome = await deps.unitOfWork.run<Written, CategoryImageWriteFailure>(market, async () => {
        const owner = await deps.categoryImages.owner(market, id.value);
        if (owner === null) return err({ code: 'category.not-found' } as const);
        if (!isEditable(owner.status)) return err({ code: 'category.not-editable' } as const);
        if (owner.version !== version.value) return err({ code: 'conflict.stale' } as const);
        const written = await deps.categoryImages.replace(market, owner, {
          id: imageId,
          uploaderAccountId: accountId,
          width: largest.width,
          height: largest.height,
          uploadedBytes: bytes.length,
          createdAt: deps.clock.now(),
          renditions,
        });
        await deps.audit.record(
          context,
          PlatformCategoryImageChangedAudit.entry(owner.id, {
            before: { imageId: written.removed?.imageId ?? null },
            after: { imageId },
          }),
        );
        await announceChanged(deps, context, owner.id, written.version);
        const treeVersion = (await deps.categories.treeVersion(market)).version;
        return ok({
          view: {
            category: {
              id: owner.id,
              slug: owner.slug,
              status: owner.status,
              version: written.version,
              revisionNo: owner.revisionNo,
              treeVersion,
            },
            image: { imageId, width: largest.width, height: largest.height },
          },
          oldKeys: written.removed?.objectKeys ?? [],
        });
      });
    } catch (error) {
      await removeObjects(deps.objectStore, stored);
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      categoryImageLogger.error({
        msg: 'catalog.category-image-set.failed',
        error: error instanceof Error ? error.name : 'unknown',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
    if (!outcome.ok) {
      await removeObjects(deps.objectStore, stored);
      return outcome;
    }
    // The old files go after the commit; a failed delete leaves an unreachable file only.
    await removeObjects(deps.objectStore, outcome.value.oldKeys);
    return ok(outcome.value.view);
  }
}
