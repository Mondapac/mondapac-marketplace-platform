import { Temporal } from '@mondapac/shared-kernel';

// Transfer execution (Phase 5 package 6c). A transfer moves money from the platform's Stripe
// balance to a seller's connected account, once, on the command of commission-payouts. Pure rules
// over the stored row and what Stripe reports; nothing here calls Stripe or the database.

/** The transfer events the receiver keeps (platform endpoint). */
export const TRANSFER_EVENT_TYPES = ['transfer.created', 'transfer.reversed'] as const;
export type TransferEventType = (typeof TRANSFER_EVENT_TYPES)[number];

export const isTransferEventType = (type: string): type is TransferEventType =>
  (TRANSFER_EVENT_TYPES as readonly string[]).includes(type);

/** `reserved` is part of the machine (data design 3.8) but is never stored: a row starts `sending`. */
export const TRANSFER_STATES = [
  'reserved',
  'sending',
  'executed',
  'refused',
  'abandoned',
  'failed',
] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

/** The closed list of why a transfer was refused or failed (no provider text is kept). */
export const TRANSFER_FAILURE_CODES = [
  'insufficient-platform-balance',
  'provider-refused',
  'transfer-failed',
] as const;
export type TransferFailureCode = (typeof TRANSFER_FAILURE_CODES)[number];

/** The definite refusals of `instructTransfer`, as commission-payouts maps them (design 4.7). */
export type TransferRefusalCode =
  | 'validation.failed'
  | 'idempotency.key-reused'
  | 'payments.transfer.currency-mismatch'
  | 'payments.transfer.amount-out-of-range'
  | 'payments.transfer.account-not-ready'
  | 'payments.transfer.cooling-off'
  /** Reserved for the "this wasn't me" report table, which is not built yet (4.7). */
  | 'payments.transfer.account-under-review'
  | 'payments.transfer.insufficient-platform-balance'
  | 'payments.transfer.provider-refused';

/** The key commission-payouts gives a transfer: its payout id, text of 1 to 128 safe characters. */
export const INSTRUCTION_KEY = /^[A-Za-z0-9:_-]{1,128}$/;

/** What commission-payouts asks for. */
export interface TransferRequest {
  readonly sellerId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly reference: string;
}

/** The content of a stored command row, for the comparison with a repeated request. */
export interface TransferContent {
  readonly sellerId: string | null;
  readonly amountMinor: bigint | null;
  readonly currency: string | null;
  readonly reference: string | null;
}

/** A repeated key stands for the same transfer only when every content field is equal. */
export const sameContent = (row: TransferContent, request: TransferRequest): boolean =>
  row.sellerId === request.sellerId &&
  row.amountMinor === request.amountMinor &&
  row.currency === request.currency &&
  row.reference === request.reference;

/** The end of a send's lease: the send is in flight until then, and never sent again. */
export const leaseEnd = (now: Temporal.Instant, seconds: number): Temporal.Instant =>
  now.add(Temporal.Duration.from({ seconds }));

/** The lease has run out at `now` (the boundary instant counts as run out). */
export const leaseExpired = (leaseUntil: Temporal.Instant | null, now: Temporal.Instant): boolean =>
  leaseUntil === null || Temporal.Instant.compare(leaseUntil, now) <= 0;

/** What Stripe reports of one transfer; the destination, key and amount are what we match on. */
export interface ProviderTransfer {
  /** tr_... */
  readonly id: string;
  /** The `mp_key` metadata payments put on it; null when it has none. */
  readonly key: string | null;
  /** acct_... */
  readonly destination: string;
  readonly amountMinor: bigint;
  /** Lower-case, as Stripe sends it. */
  readonly currency: string;
}

/** What the stored row expects of the transfer it sent. */
export interface ExpectedTransfer {
  readonly key: string;
  readonly accountRef: string;
  readonly amountMinor: bigint;
  /** Upper-case ISO 4217. */
  readonly currency: string;
}

export type TransferLookup =
  /** A transfer with this key, destination, amount and currency exists. */
  | { readonly kind: 'match'; readonly ref: string }
  /** A transfer carries this key but differs in destination, amount or currency, or two do. */
  | { readonly kind: 'partial' }
  | { readonly kind: 'none' };

/**
 * Looks for the transfer a row sent among the transfers of its transfer group. Matched on the
 * `mp_key` metadata first; a transfer with that key that differs in destination, amount or
 * currency is a partial match, which is never taken for "not sent". Transfers of other keys are
 * ignored.
 */
export function lookupTransfer(
  found: readonly ProviderTransfer[],
  expected: ExpectedTransfer,
): TransferLookup {
  const withKey = found.filter((transfer) => transfer.key === expected.key);
  if (withKey.length === 0) return { kind: 'none' };
  const full = withKey.filter(
    (transfer) =>
      transfer.destination === expected.accountRef &&
      transfer.amountMinor === expected.amountMinor &&
      transfer.currency.toUpperCase() === expected.currency,
  );
  const only = full[0];
  return withKey.length === 1 && only !== undefined
    ? { kind: 'match', ref: only.id }
    : { kind: 'partial' };
}
