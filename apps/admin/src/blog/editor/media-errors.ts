import type { ApiFailure } from '../../api/client.ts';

/** The message key (under `blog.media.error`) for a refused library call. */
const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'file.too-large': 'too-large',
  'file.unsupported-type': 'unsupported',
  'file.too-small': 'too-small',
  'file.too-many-pixels': 'too-many-pixels',
  'file.unreadable': 'unreadable',
  'blog.unavailable': 'busy',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
  'request.throttled': 'throttled',
  'request.too-large': 'too-large',
};

export function mediaProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown';
}
