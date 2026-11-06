import { Logger } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CategoryImageStore } from '../ports/category-image.store';
import type { ImageProcessor, ImageRefusalCode } from '../ports/image-processor';
import type { PlatformCategoryRepository } from '../ports/platform-category.repository';
import type { CategoryWriteFailure, CategoryWriteView } from './category-editor';

/** The dependencies of the category image writes (categories package C3c). */
export interface CategoryImageWriteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly categoryImages: CategoryImageStore;
  readonly categories: PlatformCategoryRepository;
  readonly imageProcessor: ImageProcessor;
  readonly objectStore: ObjectStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The image a category shows in the panel, or null when it has none. */
export interface CategoryImageView {
  readonly imageId: string;
  readonly width: number;
  readonly height: number;
}

/** What an image write answers: the category's new versions and its image. */
export interface CategoryImageWriteView {
  readonly category: CategoryWriteView;
  readonly image: CategoryImageView | null;
}

export type CategoryImageWriteFailure =
  | CategoryWriteFailure
  | { readonly code: Exclude<ImageRefusalCode, 'file.busy'> }
  | { readonly code: 'access.unavailable'; readonly retryAfterSeconds: number };

export const categoryImageLogger = new Logger('CategoryImage');

/** Deletes objects one by one; a failure leaves an unreachable object, never an error to the caller. */
export async function removeObjects(store: ObjectStore, keys: readonly string[]): Promise<void> {
  await Promise.all(keys.map((key) => store.delete(key).catch(() => undefined)));
}
