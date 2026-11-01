import type { useTranslations } from 'next-intl';

/** A translated label for a code, or the code itself when the panel has no text for it yet. */
export function labelOr(
  t: ReturnType<typeof useTranslations>,
  key: string,
  fallback: string,
): string {
  return t.has(key) ? t(key) : fallback;
}
