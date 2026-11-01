/**
 * The live reading of the certification claim check. The terms come from the API
 * (`GET sellers/store-profile/claim-terms`, read from the certification module); this file holds
 * no word of its own. Both sides read a text the same light way: NFKC, lower case, tokens split on
 * anything that is not a letter or a number. A phrase counts as found when its tokens appear
 * whole and in a row. The save check is wider (look-alike letters, spaced-out letters) and stays
 * the authority: a miss here never means the save passes, and a hit only moves the message ahead.
 */
const SEPARATOR = /[^\p{L}\p{N}]+/u;

export function tokensOf(text: string): readonly string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(SEPARATOR)
    .filter((token) => token.length > 0);
}

/** True when the text holds one of the phrases (each a space-joined token list) as whole tokens. */
export function claimsCertification(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const tokens = tokensOf(text);
  if (tokens.length === 0) return false;
  return terms.some((term) => {
    const phrase = term.split(' ').filter((token) => token.length > 0);
    if (phrase.length === 0) return false;
    outer: for (let at = 0; at + phrase.length <= tokens.length; at += 1) {
      for (let i = 0; i < phrase.length; i += 1) if (tokens[at + i] !== phrase[i]) continue outer;
      return true;
    }
    return false;
  });
}
