/**
 * Prepares a person's text for a Prisma `contains` filter (PostgreSQL `LIKE`/`ILIKE`): the
 * backslash and the two wildcards `%` and `_` are escaped, so they match themselves and a search
 * for `%%` cannot match every row. Prisma does not escape them. PostgreSQL's default escape
 * character is the backslash.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
