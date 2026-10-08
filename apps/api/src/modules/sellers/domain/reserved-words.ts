/**
 * The reserved words of a Market (sellers design 3.5; Ali change 3), as the domain uses them.
 * They are data from the Market configuration (`sellers.reservedWords`), never literals in this
 * module, so no word appears in `sellers`' logic. The claim group is the stand-in until
 * `certification` supplies its own through a port (design 16.2 item 6).
 */
export interface ReservedWords {
  /** Whole slugs that are never held: site routes and platform names. */
  readonly slugs: ReadonlySet<string>;
  /** Claim words, lower-case, matched per token (split on hyphens and spaces). */
  readonly claimWords: ReadonlySet<string>;
}

/** Builds the sets from the lists of a Market's `sellers.reservedWords`. */
export function reservedWordsOf(lists: {
  readonly slugs: readonly string[];
  readonly claimWords: readonly string[];
}): ReservedWords {
  return Object.freeze({
    slugs: new Set(lists.slugs),
    claimWords: new Set(lists.claimWords),
  });
}
