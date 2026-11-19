import type { ApiFailure } from '../../api/client.ts';

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
  'access.denied': 'denied',
  'request.csrf': 'csrf',
  'request.throttled': 'throttled',
};

/** The message key (under `catalog.productForm.images.error`) for a refused photo call. */
export function imageProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
