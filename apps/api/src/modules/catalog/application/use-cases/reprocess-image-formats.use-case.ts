import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { deriveFormats } from '../../../../platform/images/image-pipeline';
import {
  ObjectAlreadyExistsError,
  type ObjectStore,
} from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { ORPHAN_SWEEP_BATCH } from '../images/image-limits';
import {
  renditionObjectKey,
  type ImageMissingFormats,
  type ProductImageRepository,
  type StoredRendition,
} from '../ports/product-image.repository';

export interface ReprocessImageFormatsOutput {
  /** Photos that lacked a format when the run looked at them. */
  readonly scanned: number;
  /** Photos that now have every format. */
  readonly completed: number;
  /** Photos left as they were: a stored file could not be read or written; a second run retries. */
  readonly failed: number;
}

export type ReprocessImageFormatsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface ReprocessImageFormatsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly images: ProductImageRepository;
  readonly objectStore: ObjectStore;
}

/**
 * `catalog.reprocess-image-formats` (SEO 6B-2, package 1): gives the photos that were uploaded
 * before WebP and AVIF existed their missing formats. The raw upload is never kept, so each file
 * is written from the stored JPEG of the same size (the same pixels the buyer already sees).
 * Only clean photos are read; a taken-down photo gets nothing. For each photo the files are
 * written first and the rows after, in one unit, so a crash leaves files the orphan sweep removes
 * and never a row without a file. Safe to run twice and to stop at any point: a photo with every
 * format is not listed, and one that failed is tried again. Rule `system`, run by the operator
 * command `reprocess-image-formats --market <id>`; it holds no more than one photo's bytes at a time.
 */
export class ReprocessImageFormats extends UseCase<
  Record<string, never>,
  ReprocessImageFormatsOutput,
  ReprocessImageFormatsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.reprocess-image-formats',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ReprocessImageFormats');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReprocessImageFormatsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ReprocessImageFormatsOutput, ReprocessImageFormatsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    let scanned = 0;
    let completed = 0;
    let failed = 0;
    let afterId: string | null = null;
    for (;;) {
      const page = await deps.unitOfWork.run(
        market,
        async () =>
          ok(await deps.images.listMissingFormats(market, { afterId, limit: ORPHAN_SWEEP_BATCH })),
        { readOnly: true },
      );
      if (!page.ok) return err({ code: 'access.unavailable' });
      const { value } = page;
      // A page holds up to ORPHAN_SWEEP_BATCH photos that lack something; the cursor is the last
      // photo of the page, so a page of fewer means the end.
      for (const image of value) {
        scanned += 1;
        if (await this.#complete(context, image)) completed += 1;
        else failed += 1;
      }
      const last = value[value.length - 1];
      if (last === undefined) break;
      afterId = last.id;
    }
    this.#logger.log({
      msg: 'catalog.reprocess-image-formats',
      scanned,
      completed,
      failed,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ scanned, completed, failed });
  }

  async #complete(context: CallContext, image: ImageMissingFormats): Promise<boolean> {
    const { market } = context;
    const { deps } = this;
    const written: string[] = [];
    const rows: StoredRendition[] = [];
    try {
      for (const jpeg of image.jpegs) {
        const formats = image.missing.filter((m) => m.size === jpeg.size).map((m) => m.format);
        if (formats.length === 0) continue;
        const stored = await deps.objectStore.get(jpeg.objectKey);
        if (stored === null) return false;
        const derived = await deriveFormats(stored, formats);
        if (!derived.ok) return false;
        for (const file of derived.value) {
          const objectKey = renditionObjectKey(image.productId, image.id, jpeg.size, file.format);
          // No row names this key (the photo was listed because the row is missing), so a file
          // already there is what an earlier run left when it stopped before its rows: replace it.
          try {
            await deps.objectStore.put(objectKey, file.bytes);
          } catch (error) {
            if (!(error instanceof ObjectAlreadyExistsError)) throw error;
            await deps.objectStore.delete(objectKey);
            await deps.objectStore.put(objectKey, file.bytes);
          }
          written.push(objectKey);
          rows.push({
            size: jpeg.size,
            format: file.format,
            objectKey,
            sha256: createHash('sha256').update(file.bytes).digest(),
            byteSize: file.bytes.length,
            width: file.width,
            height: file.height,
          });
        }
      }
      const saved = await deps.unitOfWork.run(market, async () =>
        ok(await deps.images.addRenditions(market, image.productId, image.id, rows)),
      );
      if (saved.ok && saved.value) return true;
    } catch {
      // Falls through to the cleanup below.
    }
    await Promise.all(written.map((key) => deps.objectStore.delete(key).catch(() => undefined)));
    return false;
  }
}
