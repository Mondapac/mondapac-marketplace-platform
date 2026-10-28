import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type {
  StripeTransferGateway,
  TransferCreateAnswer,
  TransferReadFailure,
  TransferSnapshot,
} from '../application/ports/transfer-gateway';
import { INSTRUCTION_KEY } from '../domain/transfer';

/** How long one Stripe transfer call may take; well inside the Market's send lease. */
export const STRIPE_TRANSFER_TIMEOUT_MS = 10_000;
/** A page of the list lookup: one payout is far below it, and a fuller page is a failure. */
export const TRANSFER_LIST_LIMIT = 100;
const STRIPE_API = 'https://api.stripe.com';
const TRANSFER_ID = /^tr_[A-Za-z0-9_]{1,200}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9_]{1,200}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MARKET_ID = /^[A-Z][A-Z0-9_]{1,7}$/;
const PAYOUT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `fetch`, narrowed to what the gateway uses, so tests can pass a fake. */
export type TransferRequestFn = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

const UNAVAILABLE: TransferReadFailure = Object.freeze({
  code: 'payment.provider-unavailable' as const,
});
const REJECTED: TransferReadFailure = Object.freeze({ code: 'payment.provider-rejected' as const });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Stripe transfers over the REST API with `fetch` (no SDK), test mode only. One request per call,
 * never retried here: a transfer is created once, and an answer that leaves it unknown is looked
 * up by the caller, never sent again. The secret key and Stripe's answer bodies never reach a log
 * or an error: a failure is a code only. No description is sent: nothing free-form reaches Stripe.
 */
export class StripeTransferApiGateway implements StripeTransferGateway {
  constructor(
    private readonly secretKey: string | null,
    private readonly requestFn: TransferRequestFn = (url, init) => fetch(url, init),
    private readonly timeoutMs: number = STRIPE_TRANSFER_TIMEOUT_MS,
  ) {}

  available(): boolean {
    return this.secretKey !== null;
  }

  async createTransfer(request: {
    destination: string;
    amountMinor: bigint;
    currency: string;
    transferGroup: string;
    key: string;
    payoutId: string;
    marketId: string;
  }): Promise<TransferCreateAnswer> {
    // Nothing is sent for a request Stripe would refuse anyway, or without a key to send with.
    if (
      this.secretKey === null ||
      !ACCOUNT_ID.test(request.destination) ||
      !INSTRUCTION_KEY.test(request.key) ||
      !CURRENCY.test(request.currency) ||
      !PAYOUT_ID.test(request.payoutId) ||
      !PAYOUT_ID.test(request.transferGroup) ||
      !MARKET_ID.test(request.marketId) ||
      request.amountMinor <= 0n
    ) {
      return { kind: 'refused', code: 'provider-refused' };
    }
    const form = new URLSearchParams();
    form.set('amount', request.amountMinor.toString());
    form.set('currency', request.currency.toLowerCase());
    form.set('destination', request.destination);
    form.set('transfer_group', request.transferGroup);
    form.set('metadata[mp_key]', request.key);
    form.set('metadata[payout_id]', request.payoutId);
    form.set('metadata[market_id]', request.marketId);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    try {
      const response = await this.requestFn(`${STRIPE_API}/v1/transfers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': request.key,
        },
        body: form.toString(),
        signal: timeout.signal,
      });
      const status = response.status;
      // A conflict, a rate limit or a server error leaves the transfer's fate open.
      if (status >= 500 || status === 409 || status === 429) return { kind: 'unknown' };
      if (status >= 200 && status < 300) {
        const snapshot = toSnapshot(await response.json());
        return snapshot !== null && snapshot.key === request.key
          ? { kind: 'created', ref: snapshot.id }
          : { kind: 'unknown' };
      }
      if (status >= 400) {
        return {
          kind: 'refused',
          code: (await insufficientBalance(response)) ? 'insufficient-balance' : 'provider-refused',
        };
      }
      return { kind: 'unknown' };
    } catch {
      return { kind: 'unknown' };
    } finally {
      clearTimeout(timer);
    }
  }

  async listTransfersByGroup(
    group: string,
  ): Promise<Result<readonly TransferSnapshot[], TransferReadFailure>> {
    if (!PAYOUT_ID.test(group)) return err(REJECTED);
    const body = await this.get(
      `/v1/transfers?transfer_group=${encodeURIComponent(group)}&limit=${TRANSFER_LIST_LIMIT}`,
    );
    if (!body.ok) return body;
    const list = body.value;
    // A page that may not hold every transfer of the group cannot say "not found".
    if (!isObject(list) || list.object !== 'list' || !Array.isArray(list.data)) {
      return err(UNAVAILABLE);
    }
    if (list.has_more !== false) return err(UNAVAILABLE);
    const transfers: TransferSnapshot[] = [];
    for (const item of list.data) {
      const snapshot = toSnapshot(item);
      if (snapshot === null) return err(UNAVAILABLE);
      transfers.push(snapshot);
    }
    return ok(transfers);
  }

  async readTransfer(transferId: string): Promise<Result<TransferSnapshot, TransferReadFailure>> {
    if (!TRANSFER_ID.test(transferId)) return err(REJECTED);
    const body = await this.get(`/v1/transfers/${transferId}`);
    if (!body.ok) return body;
    const snapshot = toSnapshot(body.value);
    return snapshot === null ? err(UNAVAILABLE) : ok(snapshot);
  }

  private async get(path: string): Promise<Result<unknown, TransferReadFailure>> {
    if (this.secretKey === null) return err(UNAVAILABLE);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    try {
      const response = await this.requestFn(`${STRIPE_API}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.secretKey}` },
        signal: timeout.signal,
      });
      if (response.status >= 500 || response.status === 429) return err(UNAVAILABLE);
      if (response.status >= 400) return err(REJECTED);
      return ok(await response.json());
    } catch {
      return err(UNAVAILABLE);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Whether Stripe refused for lack of platform balance; any unreadable answer is "no". */
async function insufficientBalance(response: { json(): Promise<unknown> }): Promise<boolean> {
  try {
    const body = await response.json();
    return isObject(body) && isObject(body.error) && body.error.code === 'balance_insufficient';
  } catch {
    return false;
  }
}

/** Stripe's transfer object, narrowed; null when it is not a well-formed transfer. */
function toSnapshot(body: unknown): TransferSnapshot | null {
  if (
    !isObject(body) ||
    body.object !== 'transfer' ||
    typeof body.id !== 'string' ||
    !TRANSFER_ID.test(body.id) ||
    typeof body.livemode !== 'boolean' ||
    typeof body.amount !== 'number' ||
    !Number.isSafeInteger(body.amount) ||
    typeof body.currency !== 'string' ||
    typeof body.destination !== 'string' ||
    !ACCOUNT_ID.test(body.destination)
  ) {
    return null;
  }
  const reversed = body.amount_reversed;
  if (reversed !== undefined && (typeof reversed !== 'number' || !Number.isSafeInteger(reversed))) {
    return null;
  }
  const metadata = isObject(body.metadata) ? body.metadata : {};
  return {
    id: body.id,
    livemode: body.livemode,
    amountMinor: BigInt(body.amount),
    currency: body.currency,
    destination: body.destination,
    amountReversedMinor: BigInt(reversed ?? 0),
    key: text(metadata.mp_key),
    marketId: text(metadata.market_id),
  };
}
