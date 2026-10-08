import type { Result } from '@mondapac/shared-kernel';

/**
 * The hash queue is full (identity design 6.5): answered 503 `request.busy` with
 * `retryAfterSeconds`. Nothing was hashed.
 */
export type PasswordHasherBusy = {
  readonly code: 'request.busy';
  readonly retryAfterSeconds: number;
};

/** The outcome of {@link PasswordHasher.verify}. */
export interface PasswordVerification {
  readonly matches: boolean;
  /** The stored hash uses older parameters: replace it at the next successful sign-in. */
  readonly needsRehash: boolean;
}

/**
 * Password hashing (identity design 6.5): argon2id through Node's built-in `crypto.argon2`,
 * stored as a PHC string. Hashing is slow work: a use case calls it outside any unit of work
 * (platform persistence 3.1 row 5), and a process runs at most two hashes at once with at most
 * sixteen waiting; a call beyond that is refused at once with `request.busy`.
 *
 * The plain password is never logged, returned or put in an error.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<Result<string, PasswordHasherBusy>>;
  verify(plain: string, stored: string): Promise<Result<PasswordVerification, PasswordHasherBusy>>;
}

/** Nest token of the {@link PasswordHasher}. */
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
