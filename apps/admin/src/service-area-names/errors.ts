import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'service-area.not-found': 'not-found',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
};

/** The message key (under `serviceAreas.error`) for a failed write. */
export function areaProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.status === 403) return 'denied';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}

/** The name of a language tag in English ("fa" is "Persian"); the tag itself when unknown. */
export function languageLabel(tag: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
