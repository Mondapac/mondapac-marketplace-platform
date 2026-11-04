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
  /**
   * A customer's referral code: derived (HMAC-SHA256 keyed by the pepper, over the Market and the
   * account) rather than drawn, so the same customer gets the same code every time and it can be
   * shown again without storing it. Unguessable without the pepper; `length` characters of
   * `alphabet`. Not called when `available` is false.
   */
  referralCode(subject: string, alphabet: string, length: number): string;
  /** The stored, looked-up form of a referral code: an HMAC under its own label, apart from batch codes. */
  referralHash(code: string): string;
}

export const BATCH_CODE_CRYPTO = Symbol('PROMOTIONS_BATCH_CODE_CRYPTO');
