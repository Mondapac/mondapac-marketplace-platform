/**
 * The randomness and the hash of single-use codes, behind a port so that the domain and the use
 * cases stay deterministic under test. The production adapter uses the platform's cryptographic
 * random source and a keyed HMAC-SHA256; a code is unguessable (the Market's config demands a minimum of
 * entropy for its length and alphabet).
 */
export interface BatchCodeCrypto {
  /** A random code of `length` characters, each drawn uniformly from `alphabet` (no modulo bias). */
  generate(alphabet: string, length: number): string;
  /**
   * False when the server-side pepper is missing or too short: the use cases then neither
   * generate nor look up a code (fail closed) and `hash` must not be called.
   */
  readonly available: boolean;
  /** The lower-case hex HMAC-SHA256 of a normalised code, keyed by the pepper: what is stored and looked up. */
  hash(code: string): string;
}

export const BATCH_CODE_CRYPTO = Symbol('PROMOTIONS_BATCH_CODE_CRYPTO');
