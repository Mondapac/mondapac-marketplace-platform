import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'image.limit-reached': 'limit',
  'image.in-use': 'in-use',
  'image.not-found': 'not-found',
  'product.not-found': 'not-found',
  'file.too-large': 'too-large',
  'file.unsupported-type': 'unsupported',
  'file.too-many-pixels': 'too-many-pixels',
  'file.too-small': 'too-small',
  'file.unreadable': 'unreadable',
  'seller.not-eligible': 'not-eligible',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
};

/** The message key (under `catalog.edit.photos.error`) for a refused photo call. */
export function photoProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.code === 'request.throttled') return 'throttled';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
