/** Escapes `\`, `%` and `_`, so a search term is matched as typed (LIKE patterns). */
export const likeLiteral = (term: string): string => term.replace(/[\\%_]/g, (char) => `\\${char}`);
