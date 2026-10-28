import { err, money, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import {
  PayoutChangeRecorded,
  TransferAbandoned,
  TransferExecuted,
  TransferFenceBreached,
  type TRANSFER_PATHS,
} from '../domain/audit';
import { isReady, statusOf } from '../domain/connected-account';
import { TransferChanged } from '../domain/events';
import { coolingOffAfter, isCoolingOff } from '../domain/payout-change';
import {
  INSTRUCTION_KEY,
  leaseEnd,
  leaseExpired,
  lookupTransfer,
  sameContent,
  type TransferLookup,
  type TransferRefusalCode,
  type TransferRequest,
  type TransferState,
} from '../domain/transfer';
import { decideHmac } from './external-account-check';
import type { PaymentsDependencies } from './payments-dependencies';
import type { TransferRecord } from './ports/transfer-store';
import { raiseTransferAlert, recordLiveCheckFailure, recordTransferAlert } from './transfer-alerts';

// Transfer execution (Phase 5 package 6c; design 3.5, 4.6 condition 2, 4.7). Payments sends a
// transfer to a seller on the command of commission-payouts, at most once: an answer that leaves
// it unknown is never repeated, it is looked up at Stripe by its key and reported as stored state.
// Authorization is the use cases' rule `system`; eligibility (what is owed, holds, approval) is
// commission-payouts'.

/** At most this many keys per `transferByKey` call. */
export const MAX_TRANSFER_KEYS = 100;
/** Rows looked at per run of the resolve job; the next run takes the rest. */
export const RESOLVE_BATCH = 25;
/** Tries at a guarded change that another run may have moved first. */
const ATTEMPTS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;

export type TransferUnavailable = { readonly code: 'payments.unavailable' };
export type TransferFailure = AccessDenied | TransferUnavailable;

const unavailable = (): Result<never, TransferUnavailable> => err({ code: 'payments.unavailable' });
type Path = (typeof TRANSFER_PATHS)[number];

/** What commission-payouts asks of `instructTransfer`. */
export interface TransferInstruction {
  readonly instructionKey: string;
  readonly sellerId: string;
  readonly amount: Money;
  /** The payout id of commission-payouts: the transfer group and metadata at Stripe. */
  readonly reference: string;
}

export type TransferAnswer =
  /** Stripe created the transfer (now, or when the same key was asked before). */
  | { readonly kind: 'accepted'; readonly transferExecutionId: string }
  /** Definite: nothing was sent and none will be for this answer. */
  | { readonly kind: 'refused'; readonly code: TransferRefusalCode };

const accepted = (transferExecutionId: string): Result<TransferAnswer, never> =>
  ok({ kind: 'accepted', transferExecutionId });
const refused = (code: TransferRefusalCode): Result<TransferAnswer, never> =>
  ok({ kind: 'refused', code });

/** A one-statement read: `readOnly` opens no transaction (ADR-0025). */
async function readOnly<T>(
  deps: PaymentsDependencies,
  context: CallContext,
  work: () => Promise<T>,
): Promise<T> {
  const result = await deps.unitOfWork.run<T, never>(context.market, async () => ok(await work()), {
    readOnly: true,
  });
  if (!result.ok) throw new Error('a read-only unit cannot fail');
  return result.value;
}

function parseInstruction(input: unknown): (TransferInstruction & TransferRequest) | null {
  if (typeof input !== 'object' || input === null) return null;
  const given = input as Record<string, unknown>;
  const amount = given.amount as { amount?: unknown; currency?: unknown } | null | undefined;
  if (
    typeof given.instructionKey !== 'string' ||
    !INSTRUCTION_KEY.test(given.instructionKey) ||
    typeof given.sellerId !== 'string' ||
    !UUID.test(given.sellerId) ||
    typeof given.reference !== 'string' ||
    !UUID.test(given.reference) ||
    typeof amount !== 'object' ||
    amount === null ||
    typeof amount.amount !== 'bigint' ||
    amount.amount <= 0n ||
    typeof amount.currency !== 'string' ||
    !CURRENCY.test(amount.currency)
  ) {
    return null;
  }
  return {
    instructionKey: given.instructionKey,
    sellerId: given.sellerId,
    reference: given.reference,
    amount: money(amount.amount, amount.currency),
    amountMinor: amount.amount,
    currency: amount.currency,
  };
}

/** What a stored row answers a repeated key: the same transfer repeats its state, any other refuses. */
function answerForExisting(
  row: TransferRecord,
  request: TransferRequest,
): Result<TransferAnswer, TransferUnavailable> {
  if (row.sellerId === null || !sameContent(row, request)) return refused('idempotency.key-reused');
  switch (row.state) {
    case 'executed':
      return accepted(row.id);
    case 'refused':
      return refused(
        row.failureCode === 'insufficient-platform-balance'
          ? 'payments.transfer.insufficient-platform-balance'
          : 'payments.transfer.provider-refused',
      );
    case 'failed':
      return refused('payments.transfer.provider-refused');
    case 'abandoned':
      // Commission-payouts gave this key up: it is never sent now.
      return refused('idempotency.key-reused');
    case 'reserved':
    case 'sending':
      return unavailable();
  }
}

function appendChanged(
  deps: PaymentsDependencies,
  context: CallContext,
  row: TransferRecord,
  version: number,
  state: TransferState,
  at: Temporal.Instant,
): Promise<void> {
  if (row.sellerId === null) return Promise.resolve();
  const aggregateId = row.id as Id<'TransferExecution'>;
  return deps.outbox.append(context, [
    TransferChanged.record({
      aggregateId,
      aggregateVersion: version,
      occurredAt: at,
      payload: {
        transferExecutionId: aggregateId,
        sellerId: row.sellerId as Id<'Seller'>,
        state,
      },
    }),
  ]);
}

// ---------------------------------------------------------------------------------------------
// instructTransfer

/**
 * `payments.instruct-transfer`. In order: validation and the Market's currency, the Market's
 * ceiling (an alert when exceeded), a key stored already, the stored account (ready, not cooling
 * off, hash stamped), the live re-read of the account outside any unit and the hash compared (a
 * different account starts a cooling-off), the reserving unit under the account row lock, the one
 * send outside any unit, and the answer recorded. A send whose answer is unknown stays `sending`
 * and is never sent again.
 */
export async function instructTransfer(
  deps: PaymentsDependencies,
  context: CallContext,
  input: TransferInstruction,
): Promise<Result<TransferAnswer, TransferUnavailable>> {
  const market = context.market;
  const request = parseInstruction(input);
  if (request === null) return refused('validation.failed');
  const { instructionKey, sellerId } = request;

  let marketCurrency: string;
  let limits: ReturnType<PaymentsDependencies['policy']['transferLimits']>;
  try {
    marketCurrency = deps.policy.marketCurrency(market);
    limits = deps.policy.transferLimits(market);
  } catch {
    return unavailable();
  }
  if (request.currency !== marketCurrency) return refused('payments.transfer.currency-mismatch');
  // No ceiling, no transfer (HP-9): a policy that cannot be read fails closed.
  if (limits === null) return unavailable();
  if (request.amountMinor > limits.maxTransferAmount.amount) {
    await raiseTransferAlert(deps, context, 'amount-out-of-range', sellerId);
    return refused('payments.transfer.amount-out-of-range');
  }

  const existing = await readOnly(deps, context, () =>
    deps.transfers.findByKey(market, instructionKey),
  );
  if (existing !== null) return answerForExisting(existing, request);
  // Without a Stripe key or a hash key nothing can be checked or sent.
  if (!deps.transferGateway.available() || deps.keyring.currentVersion() === null) {
    return unavailable();
  }

  // The stored account: a first look, repeated under the lock below.
  const account = await readOnly(deps, context, () => deps.accounts.find(market, sellerId));
  if (account === null || account.accountRef === null || !isReady(account.status)) {
    return refused('payments.transfer.account-not-ready');
  }
  if (isCoolingOff(account.coolingOffUntil, deps.clock.now())) {
    return refused('payments.transfer.cooling-off');
  }
  // Rule (i): a hash that was never stamped never matches.
  if (account.externalAccountHmac === null) return refused('payments.transfer.account-not-ready');

  // The live check, outside any unit. A failed read never falls back to the stored state.
  const live = await deps.connect.readAccount(account.accountRef);
  if (!live.ok) {
    await recordLiveCheckFailure(deps, context, sellerId);
    return unavailable();
  }
  const snapshot = live.value;
  if (
    snapshot.id !== account.accountRef ||
    snapshot.metadataMarketId !== market.marketId ||
    snapshot.metadataSellerId !== sellerId ||
    !isReady(statusOf(snapshot, account.status))
  ) {
    return refused('payments.transfer.account-not-ready');
  }
  const decision = decideHmac(
    deps.keyring,
    account.externalAccountHmac,
    snapshot.defaultExternalAccountId,
  );
  switch (decision.kind) {
    case 'no-account':
    case 'stamp':
      return refused('payments.transfer.account-not-ready');
    case 'key-missing':
      // Rule (iv): never a re-stamp; the transfers wait for the key.
      await raiseTransferAlert(deps, context, 'hmac-key-missing', sellerId);
      return unavailable();
    case 'changed':
      return recordLiveChange(deps, context, sellerId, decision.next);
    case 'restamp':
      // Rule (iii): the same account under an older key is re-stamped, not a change.
      await deps.unitOfWork.run<true, never>(market, async () => {
        await deps.accounts.stampExternalAccountHmac(
          market,
          sellerId,
          decision.stored,
          decision.next,
          deps.clock.now(),
        );
        return ok(true);
      });
      break;
    case 'same':
      break;
  }

  // The reserving unit: under the account row lock the account is read again, with the Clock.
  type Reserved =
    | { readonly kind: 'reserved'; readonly row: TransferRecord }
    | { readonly kind: 'refused'; readonly code: TransferRefusalCode }
    | { readonly kind: 'existing' };
  const reserved = await deps.unitOfWork.run<Reserved, never>(market, async () => {
    const at = deps.clock.now();
    const locked = await deps.accounts.lockForTransfer(market, sellerId, at);
    if (
      locked === null ||
      locked.accountRef !== account.accountRef ||
      !isReady(locked.status) ||
      locked.externalAccountHmac === null ||
      // A change recorded since the live check (a webhook) was not part of what was verified.
      locked.lastChangeId !== account.lastChangeId
    ) {
      return ok({ kind: 'refused', code: 'payments.transfer.account-not-ready' });
    }
    if (isCoolingOff(locked.coolingOffUntil, at)) {
      return ok({ kind: 'refused', code: 'payments.transfer.cooling-off' });
    }
    const row: TransferRecord = {
      id: deps.ids.next<'TransferExecution'>(),
      instructionKey,
      sellerId,
      accountRef: account.accountRef,
      amountMinor: request.amountMinor,
      currency: request.currency,
      reference: request.reference,
      state: 'sending',
      providerTransferRef: null,
      failureCode: null,
      reversedMinor: 0n,
      sendCount: 1,
      leaseUntil: leaseEnd(at, limits.sendLeaseSeconds),
      abandonedAt: null,
      fenceBreachedAt: null,
      executedAt: null,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    // Another instruction with the same key got in first (or a tombstone is there).
    if ((await deps.transfers.insert(market, row)) === 'conflict') return ok({ kind: 'existing' });
    return ok({ kind: 'reserved', row });
  });
  if (!reserved.ok) return unavailable();
  if (reserved.value.kind === 'refused') return refused(reserved.value.code);
  if (reserved.value.kind === 'existing') {
    const stored = await readOnly(deps, context, () =>
      deps.transfers.findByKey(market, instructionKey),
    );
    return stored === null ? unavailable() : answerForExisting(stored, request);
  }
  const row = reserved.value.row;

  // The one send, outside any unit. An unknown answer is not repeated.
  const sent = await deps.transferGateway.createTransfer({
    destination: account.accountRef,
    amountMinor: request.amountMinor,
    currency: request.currency,
    transferGroup: request.reference,
    key: instructionKey,
    payoutId: request.reference,
    marketId: market.marketId,
  });
  if (sent.kind === 'unknown') return unavailable();
  if (sent.kind === 'refused') return settleRefused(deps, context, row, sent.code);
  const settled = await recordTransfer(deps, context, instructionKey, sent.ref, 'send');
  return settled === null || settled.kind === 'anomaly' ? unavailable() : accepted(row.id);
}

/** The live hash differs from the one on record: a changed bank account, a waiting period, no transfer. */
async function recordLiveChange(
  deps: PaymentsDependencies,
  context: CallContext,
  sellerId: string,
  next: string,
): Promise<Result<TransferAnswer, TransferUnavailable>> {
  const market = context.market;
  const recorded = await deps.unitOfWork.run<boolean, never>(market, async () => {
    const at = deps.clock.now();
    const locked = await deps.accounts.lockForTransfer(market, sellerId, at);
    if (locked === null) return ok(false);
    const until = coolingOffAfter(
      'updated',
      at,
      deps.policy.bankChangeCoolingOffHours(market),
      locked.coolingOffUntil,
    );
    const changeId = deps.ids.next<'PayoutChange'>();
    const result = await deps.accounts.recordChange(
      market,
      sellerId,
      {
        id: changeId,
        kind: 'updated',
        detectedAt: at,
        coolingOffUntil: until,
        sourceEventId: null,
        detectedBy: 'live-check',
        externalAccountHmac: next,
      },
      locked.lastChangeId,
      until,
      at,
    );
    if (result !== 'recorded') return ok(false);
    await deps.audit.record(
      context,
      PayoutChangeRecorded.entry(sellerId as Id<'Seller'>, {
        after: { changeId, kind: 'updated', coolingOffUntil: until },
      }),
    );
    return ok(true);
  });
  // A change that another unit recorded first is not told apart here: ask again later.
  return recorded.ok && recorded.value ? refused('payments.transfer.cooling-off') : unavailable();
}

/** Stripe refused the create call (a 4xx): the row ends `refused`, and the refusal is definite. */
async function settleRefused(
  deps: PaymentsDependencies,
  context: CallContext,
  row: TransferRecord,
  reason: 'insufficient-balance' | 'provider-refused',
): Promise<Result<TransferAnswer, TransferUnavailable>> {
  const market = context.market;
  const insufficient = reason === 'insufficient-balance';
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const done = await deps.unitOfWork.run<boolean, never>(market, async () => {
      const fresh = await deps.transfers.findByKey(market, row.instructionKey);
      if (fresh === null || fresh.state !== 'sending') return ok(false);
      const at = deps.clock.now();
      const changed = await deps.transfers.change(
        market,
        fresh.id,
        { state: 'sending', version: fresh.version },
        {
          state: 'refused',
          failureCode: insufficient ? 'insufficient-platform-balance' : 'provider-refused',
        },
        at,
      );
      if (!changed) return ok(false);
      await appendChanged(deps, context, fresh, fresh.version + 1, 'refused', at);
      if (insufficient) {
        await recordTransferAlert(deps, context, 'insufficient-platform-balance', row.sellerId);
      }
      return ok(true);
    });
    if (done.ok && done.value) break;
  }
  return refused(
    insufficient
      ? 'payments.transfer.insufficient-platform-balance'
      : 'payments.transfer.provider-refused',
  );
}

// ---------------------------------------------------------------------------------------------
// A transfer found at Stripe: by the send's own answer, a lookup by key, or the webhook

export type Settled = {
  readonly kind: 'executed' | 'breached' | 'already' | 'anomaly';
  readonly transferExecutionId: string;
};

/**
 * Inside an open unit: the transfer `ref` exists at Stripe for this stored row. A `sending` row
 * becomes `executed`; an `abandoned` one that was sent is the fence breach (executed, stamped,
 * audited and alerted); an executed one with the same id changes nothing. Anything else (another
 * id for the key, a refused row) is an anomaly: alerted, nothing changed.
 */
export async function settleFound(
  deps: PaymentsDependencies,
  context: CallContext,
  row: TransferRecord,
  ref: string,
  path: Path,
): Promise<Result<Settled, { readonly code: 'conflict' }>> {
  const market = context.market;
  const at = deps.clock.now();
  const sellerId = row.sellerId;
  if (sellerId === null) {
    // A tombstone was never sent: a transfer with its key cannot be recorded against it.
    await recordTransferAlert(deps, context, 'partial-match', null);
    return ok({ kind: 'anomaly', transferExecutionId: row.id });
  }
  const anomaly = async (): Promise<Result<Settled, never>> => {
    await recordTransferAlert(deps, context, 'partial-match', sellerId);
    return ok({ kind: 'anomaly', transferExecutionId: row.id });
  };
  switch (row.state) {
    case 'reserved':
    case 'sending': {
      const changed = await deps.transfers.change(
        market,
        row.id,
        { state: row.state, version: row.version },
        { state: 'executed', providerTransferRef: ref, executedAt: at },
        at,
      );
      if (!changed) return err({ code: 'conflict' });
      await appendChanged(deps, context, row, row.version + 1, 'executed', at);
      await deps.audit.record(
        context,
        TransferExecuted.entry(row.id as Id<'TransferExecution'>, {
          after: { sellerId: sellerId as Id<'Seller'>, path },
        }),
      );
      await alertDailyTotal(deps, context, row);
      return ok({ kind: 'executed', transferExecutionId: row.id });
    }
    case 'abandoned': {
      if (row.sendCount !== 1) return anomaly();
      const changed = await deps.transfers.change(
        market,
        row.id,
        { state: 'abandoned', version: row.version },
        { state: 'executed', providerTransferRef: ref, executedAt: at, fenceBreachedAt: at },
        at,
      );
      if (!changed) return err({ code: 'conflict' });
      await appendChanged(deps, context, row, row.version + 1, 'executed', at);
      await deps.audit.record(
        context,
        TransferFenceBreached.entry(row.id as Id<'TransferExecution'>, {
          after: { sellerId: sellerId as Id<'Seller'>, path },
        }),
      );
      await recordTransferAlert(deps, context, 'fence-breached', sellerId);
      await alertDailyTotal(deps, context, row);
      return ok({ kind: 'breached', transferExecutionId: row.id });
    }
    case 'executed':
      if (row.providerTransferRef === ref) {
        return ok({ kind: 'already', transferExecutionId: row.id });
      }
      return anomaly();
    case 'refused':
    case 'failed':
      return anomaly();
  }
}

/** The day's executed total (in the Market's zone) above the threshold raises an alert; in the unit. */
async function alertDailyTotal(
  deps: PaymentsDependencies,
  context: CallContext,
  row: TransferRecord,
): Promise<void> {
  const market = context.market;
  const limits = deps.policy.transferLimits(market);
  if (limits === null || row.currency === null) return;
  const day = deps.clock.now().toZonedDateTimeISO(deps.policy.marketTimeZone(market)).startOfDay();
  const total = await deps.transfers.executedTotal(
    market,
    row.currency,
    day.toInstant(),
    day.add({ days: 1 }).toInstant(),
  );
  if (
    row.currency === limits.dailyTransferAlertThreshold.currency &&
    total > limits.dailyTransferAlertThreshold.amount
  ) {
    await recordTransferAlert(deps, context, 'daily-total-over-threshold', row.sellerId);
  }
}

/** Records a transfer found at Stripe against its row, in a unit of its own; null after the retries. */
export async function recordTransfer(
  deps: PaymentsDependencies,
  context: CallContext,
  instructionKey: string,
  ref: string,
  path: Path,
): Promise<Settled | null> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const result = await deps.unitOfWork.run<Settled, { readonly code: 'conflict' }>(
      context.market,
      async () => {
        const fresh = await deps.transfers.findByKey(context.market, instructionKey);
        if (fresh === null) return err({ code: 'conflict' });
        return settleFound(deps, context, fresh, ref, path);
      },
    );
    if (result.ok) return result.value;
  }
  return null;
}

/** The transfers of the row's group at Stripe, matched on key, destination, amount and currency. */
async function lookupFor(
  deps: PaymentsDependencies,
  row: TransferRecord,
): Promise<TransferLookup | null> {
  if (
    row.reference === null ||
    row.accountRef === null ||
    row.amountMinor === null ||
    row.currency === null
  ) {
    return { kind: 'none' };
  }
  const listed = await deps.transferGateway.listTransfersByGroup(row.reference);
  if (!listed.ok) return null;
  return lookupTransfer(listed.value, {
    key: row.instructionKey,
    accountRef: row.accountRef,
    amountMinor: row.amountMinor,
    currency: row.currency,
  });
}

// ---------------------------------------------------------------------------------------------
// transferByKey

/** A stored transfer as commission-payouts reads it: state, id, amount and what was reversed. */
export interface TransferView {
  readonly instructionKey: string;
  /** `none` when no row exists for the key. */
  readonly state: TransferState | 'none';
  readonly transferExecutionId: string | null;
  readonly amount: Money | null;
  readonly reversed: Money | null;
}

export type TransferByKeyFailure = AccessDenied | { readonly code: 'validation.failed' };

/** `payments.transfer-by-key`: stored state of up to 100 keys, in one statement, no call to Stripe. */
export async function transferByKey(
  deps: PaymentsDependencies,
  context: CallContext,
  instructionKeys: readonly string[],
): Promise<Result<readonly TransferView[], TransferByKeyFailure>> {
  const given: unknown = instructionKeys;
  if (
    !Array.isArray(given) ||
    given.length > MAX_TRANSFER_KEYS ||
    !given.every((key: unknown) => typeof key === 'string' && INSTRUCTION_KEY.test(key))
  ) {
    return err({ code: 'validation.failed' });
  }
  const rows = await readOnly(deps, context, () =>
    deps.transfers.findManyByKey(context.market, instructionKeys),
  );
  const byKey = new Map(rows.map((row) => [row.instructionKey, row]));
  return ok(
    instructionKeys.map((instructionKey): TransferView => {
      const row = byKey.get(instructionKey);
      if (row === undefined) {
        return {
          instructionKey,
          state: 'none',
          transferExecutionId: null,
          amount: null,
          reversed: null,
        };
      }
      return {
        instructionKey,
        state: row.state,
        transferExecutionId: row.id,
        amount:
          row.amountMinor === null || row.currency === null
            ? null
            : money(row.amountMinor, row.currency),
        reversed: row.currency === null ? null : money(row.reversedMinor, row.currency),
      };
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// abandonTransfer

export type AbandonAnswer =
  /** Nothing was sent and none will be; `abandonedAt` is when it was decided. */
  | { readonly kind: 'abandoned'; readonly abandonedAt: Temporal.Instant }
  /** The quarantine pass found nothing: still not sent. */
  | { readonly kind: 'still-abandoned' }
  /** A transfer exists (found now or before): the key is executed. */
  | { readonly kind: 'already-sent'; readonly transferExecutionId: string }
  /** The send is still inside its lease. */
  | { readonly kind: 'in-flight' };

export type AbandonFailure = TransferFailure | { readonly code: 'validation.failed' };

/**
 * `payments.abandon-transfer` (the fence, as `abandonRefund`). No row: a tombstone, so a late
 * instruct with the key is refused. `sending` inside the lease: in flight. Past the lease: a
 * lookup by transfer group outside any unit, matched on key, destination and amount; found:
 * executed; not found: a guarded abandon. On an `abandoned` row the lookup repeats (the
 * quarantine pass): found is a fence breach; a partial match alerts and answers unavailable.
 */
export async function abandonTransfer(
  deps: PaymentsDependencies,
  context: CallContext,
  instructionKey: string,
): Promise<Result<AbandonAnswer, AbandonFailure>> {
  if (typeof instructionKey !== 'string' || !INSTRUCTION_KEY.test(instructionKey)) {
    return err({ code: 'validation.failed' });
  }
  const market = context.market;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const row = await readOnly(deps, context, () =>
      deps.transfers.findByKey(market, instructionKey),
    );
    if (row === null) {
      const at = deps.clock.now();
      const tombstoned = await deps.unitOfWork.run<boolean, never>(market, async () => {
        const id = deps.ids.next<'TransferExecution'>();
        const inserted = await deps.transfers.insertTombstone(market, { id, instructionKey, at });
        if (inserted === 'conflict') return ok(false);
        await deps.audit.record(
          context,
          TransferAbandoned.entry(id, { after: { sellerId: null } }),
        );
        return ok(true);
      });
      // A concurrent instruct stored the key first: decide on that row.
      if (tombstoned.ok && tombstoned.value) return ok({ kind: 'abandoned', abandonedAt: at });
      continue;
    }
    const answer = await decideAbandon(deps, context, row);
    if (answer !== 'retry') return answer;
  }
  return unavailable();
}

async function decideAbandon(
  deps: PaymentsDependencies,
  context: CallContext,
  row: TransferRecord,
): Promise<Result<AbandonAnswer, TransferUnavailable> | 'retry'> {
  switch (row.state) {
    case 'executed':
    case 'failed':
      return ok({ kind: 'already-sent', transferExecutionId: row.id });
    case 'refused':
      // Stripe refused it: nothing was created.
      return ok({ kind: 'abandoned', abandonedAt: row.updatedAt });
    case 'reserved':
      return abandonRow(deps, context, row);
    case 'sending': {
      if (!leaseExpired(row.leaseUntil, deps.clock.now())) return ok({ kind: 'in-flight' });
      const found = await lookupFor(deps, row);
      if (found === null) return unavailable();
      if (found.kind === 'partial') {
        await raiseTransferAlert(deps, context, 'partial-match', row.sellerId);
        return unavailable();
      }
      if (found.kind === 'match') return foundAnswer(deps, context, row, found.ref, 'lookup');
      return abandonRow(deps, context, row);
    }
    case 'abandoned': {
      // Never sent (a tombstone, or abandoned before the send): nothing to look for.
      if (row.sendCount !== 1) return ok({ kind: 'still-abandoned' });
      const found = await lookupFor(deps, row);
      if (found === null) return unavailable();
      if (found.kind === 'partial') {
        await raiseTransferAlert(deps, context, 'partial-match', row.sellerId);
        return unavailable();
      }
      if (found.kind === 'match') return foundAnswer(deps, context, row, found.ref, 'lookup');
      return ok({ kind: 'still-abandoned' });
    }
  }
}

async function foundAnswer(
  deps: PaymentsDependencies,
  context: CallContext,
  row: TransferRecord,
  ref: string,
  path: Path,
): Promise<Result<AbandonAnswer, TransferUnavailable> | 'retry'> {
  const settled = await recordTransfer(deps, context, row.instructionKey, ref, path);
  if (settled === null || settled.kind === 'anomaly') return unavailable();
  return ok({ kind: 'already-sent', transferExecutionId: settled.transferExecutionId });
}

/** The guarded `sending` (or `reserved`) to `abandoned`; `retry` when another run moved the row. */
async function abandonRow(
  deps: PaymentsDependencies,
  context: CallContext,
  stale: TransferRecord,
): Promise<Result<AbandonAnswer, TransferUnavailable> | 'retry'> {
  const market = context.market;
  const at = deps.clock.now();
  const done = await deps.unitOfWork.run<boolean, never>(market, async () => {
    const fresh = await deps.transfers.findByKey(market, stale.instructionKey);
    if (fresh === null || (fresh.state !== 'sending' && fresh.state !== 'reserved')) {
      return ok(false);
    }
    // A send that is in flight again cannot happen: the lease only runs out.
    if (fresh.state === 'sending' && !leaseExpired(fresh.leaseUntil, at)) return ok(false);
    const changed = await deps.transfers.change(
      market,
      fresh.id,
      { state: fresh.state, version: fresh.version },
      { state: 'abandoned', abandonedAt: at },
      at,
    );
    if (!changed) return ok(false);
    await appendChanged(deps, context, fresh, fresh.version + 1, 'abandoned', at);
    await deps.audit.record(
      context,
      TransferAbandoned.entry(fresh.id as Id<'TransferExecution'>, {
        after: { sellerId: fresh.sellerId as Id<'Seller'> | null },
      }),
    );
    return ok(true);
  });
  return done.ok && done.value ? ok({ kind: 'abandoned', abandonedAt: at }) : 'retry';
}

// ---------------------------------------------------------------------------------------------
// resolve-transfers (the worker job)

export interface ResolveSummary {
  /** Rows whose transfer was found at Stripe and recorded. */
  readonly resolved: number;
  /** Rows left `sending`: not found (commission-payouts abandons them), or a lookup that failed. */
  readonly pending: number;
  /** Partial matches and anomalies, alerted. */
  readonly alerts: number;
}

export type ResolveFailure = AccessDenied;

/**
 * `payments.resolve-transfers`: each `sending` row past its lease is looked up at Stripe by its
 * key; found means executed. Nothing is ever sent, and a row that is not found is left for
 * commission-payouts' `abandonTransfer`, after its own timeout.
 */
export async function resolveTransfers(
  deps: PaymentsDependencies,
  context: CallContext,
): Promise<Result<ResolveSummary, ResolveFailure>> {
  const market = context.market;
  const due = await readOnly(deps, context, () =>
    deps.transfers.sendingPastLease(market, deps.clock.now(), RESOLVE_BATCH),
  );
  let resolved = 0;
  let pending = 0;
  let alerts = 0;
  for (const row of due) {
    const found = await lookupFor(deps, row);
    if (found === null || found.kind === 'none') {
      pending += 1;
      continue;
    }
    if (found.kind === 'partial') {
      await raiseTransferAlert(deps, context, 'partial-match', row.sellerId);
      alerts += 1;
      continue;
    }
    const settled = await recordTransfer(deps, context, row.instructionKey, found.ref, 'lookup');
    if (settled === null) pending += 1;
    else if (settled.kind === 'anomaly') alerts += 1;
    else resolved += 1;
  }
  return ok({ resolved, pending, alerts });
}
