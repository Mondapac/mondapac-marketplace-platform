/**
 * The handover code of an agent invitation (ADR-0045 decision 2): at least 40 random bits in
 * base32, given to the agent directly by the admin, so neither the mailed link nor the inviting
 * admin alone can take the account. Ten characters of the RFC 4648 alphabet are 50 bits. Only an
 * HMAC of the code is stored (the code is never kept and cannot be shown again), and five failed
 * attempts void it.
 */
export const HANDOVER_CODE_LENGTH = 10;
export const HANDOVER_MAX_FAILED_ATTEMPTS = 5;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * The code shown to the admin ("ABCDE-FGHIJ") from `HANDOVER_CODE_LENGTH` random bytes of the
 * system random source. The low five bits of a byte are uniform because 256 is a multiple of 32.
 */
export function handoverCodeFromRandom(random: Uint8Array): string {
  if (random.length < HANDOVER_CODE_LENGTH) {
    throw new RangeError(`a handover code needs ${HANDOVER_CODE_LENGTH} random bytes`);
  }
  let text = '';
  for (let index = 0; index < HANDOVER_CODE_LENGTH; index += 1) {
    text += ALPHABET[random[index]! & 31];
  }
  return `${text.slice(0, 5)}-${text.slice(5)}`;
}

/**
 * A typed code in its stored form (ten upper-case characters), or null when it is not shaped
 * like a code: case, spaces and the hyphen are ignored. Nothing is counted for a malformed one.
 */
export function normaliseHandoverCode(typed: unknown): string | null {
  if (typeof typed !== 'string' || typed.length > 40) return null;
  // ASCII only before the case fold: 'ß' would fold to 'SS' and 'ı' to 'I'.
  if (!/^[A-Za-z2-7\s-]*$/.test(typed)) return null;
  const compact = typed.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z2-7]{10}$/.test(compact) ? compact : null;
}
