import type { TypeListRow } from './types.ts';

/** The code to name map of the Market's types, in the panel locale; a code without a name keeps the code. */
export function typeNames(
  types: readonly TypeListRow[],
  locale: string,
): ReadonlyMap<string, string> {
  const language = locale.split('-')[0] ?? locale;
  return new Map(
    types.map((type) => {
      const name = type.names[locale] ?? type.names[language] ?? Object.values(type.names)[0];
      return [type.code, name !== undefined && name !== '' ? name : type.code];
    }),
  );
}
