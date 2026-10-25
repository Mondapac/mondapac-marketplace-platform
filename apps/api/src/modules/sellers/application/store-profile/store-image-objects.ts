import type { Id } from '@mondapac/shared-kernel';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { StoreImageSize } from '../../domain/store-image';

/**
 * The object key of one rendition: built by code from ids and a closed size, never from a
 * request. It starts with the seller id (a CHECK of the table says so), so a key never names
 * another seller's folder, and it is a valid key of the object store (letters, digits, `-`).
 */
export function storeImageObjectKey(
  sellerId: Id<'Seller'>,
  imageId: Id<'StoreImage'>,
  size: StoreImageSize,
): string {
  return `${sellerId}/store-images/${imageId}/${size}`;
}

/** Deletes objects one by one; a failure leaves an unreachable object, never an error to the caller. */
export async function removeObjects(store: ObjectStore, keys: readonly string[]): Promise<void> {
  await Promise.all(keys.map((key) => store.delete(key).catch(() => undefined)));
}
