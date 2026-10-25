import { timingSafeEqual } from 'node:crypto';
import type { Id, Temporal } from '@mondapac/shared-kernel';

// The pickup code of a seller order whose buyer collects it in person (delivery models, package
// 2). The platform issues a 4-digit code when the seller says the order is ready; only the buyer
// can read it. At the handover the seller types the buyer's code. The seller never delivers.
//
// A wrong code is counted per seller order: after `PICKUP_MAX_FAILED_ATTEMPTS` failures the order
// is locked and the seller cannot try again. Only the buyer can open it again, by asking for a
// new code (which also resets the count). 4 digits are 10,000 codes, so 5 tries give a guesser a
// 0.05% chance on one order, and a lock stops the rest.

/** The length of the code, in digits. */
export const PICKUP_CODE_DIGITS = 4;
/** How many wrong codes a seller order takes before it is locked. */
export const PICKUP_MAX_FAILED_ATTEMPTS = 5;

const CODE_COUNT = 10 ** PICKUP_CODE_DIGITS;
const PATTERN = new RegExp(`^[0-9]{${PICKUP_CODE_DIGITS}}$`);

/** A source of a whole number in `[0, maxExclusive)`; production passes a CSPRNG. */
export type RandomInt = (maxExclusive: number) => number;

/** A fresh code: uniform over 0000 to 9999, with leading zeros kept. */
export function newPickupCode(randomInt: RandomInt): string {
  const value = randomInt(CODE_COUNT);
  if (!Number.isSafeInteger(value) || value < 0 || value >= CODE_COUNT) {
    throw new RangeError('The random source answered outside the code range');
  }
  return String(value).padStart(PICKUP_CODE_DIGITS, '0');
}

/** The code as typed: exactly 4 ASCII digits, nothing else (no spaces, no signs). Else null. */
export function parsePickupCode(value: unknown): string | null {
  return typeof value === 'string' && PATTERN.test(value) ? value : null;
}

/**
 * Whether two stored hashes are equal, in time that does not depend on where they differ. Hashes
 * of different lengths are never equal (they would not come from the same keyed hash).
 */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A seller order's code as stored: the keyed hash to check, the sealed copy for the buyer. */
export interface PickupCodeRecord {
  readonly sellerOrderId: Id<'SellerOrder'>;
  /** The keyed hash of the code; never the code. */
  readonly hash: string;
  /** The code sealed under the buyer's key: opened only for the buyer's own view. */
  readonly sealed: string;
  readonly failedAttempts: number;
  /** Set when the failures reached the limit; cleared by a new code. */
  readonly lockedAt: Temporal.Instant | null;
  readonly issuedAt: Temporal.Instant;
}

/** What the seller panel may know about the code: how many tries are left, or that it is locked. */
export interface PickupStatus {
  readonly attemptsLeft: number;
  readonly locked: boolean;
}

export function pickupStatusOf(
  record: Pick<PickupCodeRecord, 'failedAttempts' | 'lockedAt'>,
): PickupStatus {
  const locked = record.lockedAt !== null || record.failedAttempts >= PICKUP_MAX_FAILED_ATTEMPTS;
  return {
    attemptsLeft: locked ? 0 : PICKUP_MAX_FAILED_ATTEMPTS - record.failedAttempts,
    locked,
  };
}
