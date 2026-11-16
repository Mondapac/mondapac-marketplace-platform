// The column choice of a Sales list: the ids of the optional columns the admin shows, in order. It
// is the admin's own and lives in this browser's storage; the list works without storage.

/**
 * The columns a stored choice names, in its order: unknown and repeated ids are dropped. Nothing
 * stored means the defaults; a stored choice with no column left means the fixed columns alone.
 */
export function cleanColumnIds<T extends string>(
  saved: readonly unknown[] | undefined,
  optional: readonly T[],
  defaults: readonly T[],
): readonly T[] {
  if (saved === undefined) return defaults;
  const known = saved.filter((id): id is T => optional.some((column) => column === id));
  return [...new Set(known)];
}
