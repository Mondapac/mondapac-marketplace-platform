import { timingSafeEqual } from 'node:crypto';
import { hmacVersion } from '../domain/external-account';
import type { ExternalAccountKeyring } from './ports/external-account-keyring';

// The keyed hash of a connected account's default external account id (design 4.6 HP-1 condition
// 2, rules i to v). A pure decision over the stored value, the id Stripe shows now and the keys;
// the callers write what it decides (the re-read handler and `instructTransfer`'s live check).

export type HmacDecision =
  /** Stripe shows no default external account: there is nothing to compare or stamp. */
  | { readonly kind: 'no-account' }
  /** The stored value is the value now (under the current key): nothing to do. */
  | { readonly kind: 'same'; readonly value: string }
  /** Never stamped (rule i: a NULL never matches a transfer): stamp this first value. */
  | { readonly kind: 'stamp'; readonly next: string }
  /** The same account under an older key version (rule iii): re-stamp under the current one. */
  | { readonly kind: 'restamp'; readonly stored: string; readonly next: string }
  /** A different account: a detected change; `next` is the value to store with its change row. */
  | { readonly kind: 'changed'; readonly stored: string; readonly next: string }
  /** The key of the stored version (or the current version) is missing (rule iv): never re-stamped. */
  | { readonly kind: 'key-missing' };

/** Compares two stored values in constant time over the whole value (rule ii). */
export function sameHmac(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Decides what the id Stripe shows now means for the stored value. The stored value is always
 * recomputed with the key of its own version, so a key rotation is never read as a changed bank
 * account; a value that differs under its own version is.
 */
export function decideHmac(
  keyring: ExternalAccountKeyring,
  stored: string | null,
  providerId: string | null,
): HmacDecision {
  if (providerId === null) return { kind: 'no-account' };
  const current = keyring.currentVersion();
  if (stored === null) {
    const next = current === null ? null : keyring.hmac(current, providerId);
    return next === null ? { kind: 'key-missing' } : { kind: 'stamp', next };
  }
  const version = hmacVersion(stored);
  const recomputed = version === null ? null : keyring.hmac(version, providerId);
  if (version === null || recomputed === null) return { kind: 'key-missing' };
  const latest = current === null ? recomputed : (keyring.hmac(current, providerId) ?? recomputed);
  if (!sameHmac(recomputed, stored)) return { kind: 'changed', stored, next: latest };
  return latest === stored
    ? { kind: 'same', value: stored }
    : { kind: 'restamp', stored, next: latest };
}
