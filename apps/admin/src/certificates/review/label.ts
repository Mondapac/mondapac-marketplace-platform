/** A translator that can say whether a key exists (next-intl's `t.has`). */
interface Lookup {
  (key: never): string;
  has(key: never): boolean;
}

/**
 * The words for a code the API sends (a check, a reason, a status, an outcome). A code with no
 * words in this panel's language shows as the code itself, never as nothing.
 */
export function wordsFor(t: Lookup, group: string, code: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(code)) return code;
  const key = `certificates.review.${group}.${code}` as never;
  return t.has(key) ? t(key) : code;
}
