/** The text for the requested locale, else the fallback, else the first locale in code order. */
export function pick(
  texts: Readonly<Record<string, string>>,
  locales: { readonly requested: string; readonly fallback: string },
): string | null {
  if (typeof texts[locales.requested] === 'string') return texts[locales.requested]!;
  if (typeof texts[locales.fallback] === 'string') return texts[locales.fallback]!;
  const first = Object.keys(texts).sort()[0];
  return first === undefined ? null : texts[first]!;
}

export const asTexts = (value: unknown): Record<string, string> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : null;
