import { err, money, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type {
  GrantCreditRequest,
  GrantCreditResult,
  HoldResult,
  PlaceHoldRequest,
  SettleHoldRequest,
  WalletBalanceView,
  WalletFailure,
} from '../contracts/wallet.facade';
import { promoExpiry } from '../domain/expiry';
import { allocate } from '../domain/lots';
import { refusalFor, type WalletOperation } from '../domain/wallet-status';
import type { WalletSettings } from './ports/wallet-policy';
import type { WalletDependencies } from './wallet-dependencies';
import type {
  BalanceRecord,
  HoldRecord,
  InternalAccountKind,
  JournalKind,
  NewJournal,
  WalletAccountRecord,
} from './ports/wallet.repository';

// The ledger core (customer wallet package 1): store credit issued by the platform, as lots; a
// hold sets credit aside for one order, capture spends it, release gives it back to the same
// lots. Every change is one balanced, insert-only journal, written in the unit that holds the
// wallet's balance row lock, and is idempotent by key. Money is bigint minor units only.

export type { WalletFailure };

const MAX_MINOR = 9_000_000_000_000_000n;
const REASON = /^[a-z][a-z0-9-]{1,39}$/;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;

type Problem = { path: string; code: string };

export const idOf = <K extends string>(value: unknown): Id<K> | null => {
  const parsed = typeof value === 'string' ? parseId<K>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

export const invalid = (fields: readonly Problem[]): WalletFailure => ({
  code: 'validation.failed',
  fields,
});

/** A positive amount in the Market currency, within the range of the column. */
export function amountProblem(value: Money | undefined, currency: string): boolean {
  return (
    typeof value?.amount !== 'bigint' ||
    value.amount <= 0n ||
    value.amount > MAX_MINOR ||
    value.currency !== currency
  );
}

/** The prefix of the keys the worker generates; a caller of the facade may not use it. */
export const INTERNAL_KEY_PREFIX = 'sys:';

export const keyOk = (value: unknown): value is string =>
  typeof value === 'string' && KEY.test(value) && !value.startsWith(INTERNAL_KEY_PREFIX);

/** Who is recorded on the journal. The facade is for the system; admins join in package 2. */
export function actorOf(context: CallContext): NewJournal['actor'] {
  const actor = context.actor;
  if (actor.kind === 'authenticated') {
    return { kind: actor.population === 'customer' ? 'customer' : 'admin', id: actor.accountId };
  }
  return { kind: 'system', id: null };
}

/** The Market's wallet state, read in the unit; the refusal for an operation it does not allow. */
export async function gate(
  deps: WalletDependencies,
  context: CallContext,
  operation: WalletOperation,
): Promise<WalletFailure | null> {
  const row = await deps.settings.find(context.market);
  const refusal = refusalFor(row?.status ?? 'off', operation);
  return refusal === null ? null : { code: refusal };
}

const balanceOfRecord = (record: BalanceRecord, currency: string) => ({
  available: money(record.availableMinor, currency),
  held: money(record.heldMinor, currency),
});

/** The first answer of a journal with the same key, or a refusal when the request differs. */
async function replayOf<T>(
  deps: WalletDependencies,
  context: CallContext,
  key: string,
  fingerprint: string,
  decode: (result: Readonly<Record<string, string>>) => T | Promise<T>,
): Promise<Result<T, WalletFailure> | null> {
  const found = await deps.wallet.findJournal(context.market, key);
  if (found === null) return null;
  if (found.fingerprint !== fingerprint) return err({ code: 'idempotency.key-reused' });
  return ok(await decode(found.result));
}

/**
 * What Prisma reports of a database error that came from a statement on one model: the model and
 * the SQLSTATE, read from the two documented places only (`meta.modelName` and
 * `meta.driverAdapterError.cause.originalCode`). Never decided from message text.
 */
export function databaseErrorOf(error: unknown): { model?: string; sqlState?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const meta = (error as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return {};
  const { modelName, driverAdapterError } = meta as {
    modelName?: unknown;
    driverAdapterError?: { cause?: { originalCode?: unknown } };
  };
  const sqlState = driverAdapterError?.cause?.originalCode;
  return {
    ...(typeof modelName === 'string' ? { model: modelName } : {}),
    ...(typeof sqlState === 'string' ? { sqlState } : {}),
  };
}

/** Two requests with one key met in the unique index of `(market_id, idempotency_key)`: 23505 on a journal. */
const isKeyConflict = (error: unknown): boolean => {
  const { model, sqlState } = databaseErrorOf(error);
  return model === 'WalletJournal' && sqlState === '23505';
};

/** The status fence (`restrict_violation`, 23001) refused the insert of a journal. */
export const isStatusFence = (error: unknown, model = 'WalletJournal'): boolean => {
  const found = databaseErrorOf(error);
  return found.model === model && found.sqlState === '23001';
};

/**
 * Runs a write unit and turns its two expected races into answers. A unique violation on the
 * idempotency key (the other request won) is answered from the first journal: its result or
 * `idempotency.key-reused`. A refusal by the status fence (an admin switched the Market between
 * the gate and the insert) runs the unit once more, where the gate now sees the new status.
 */
async function guarded<T>(
  deps: WalletDependencies,
  context: CallContext,
  key: string,
  fingerprint: string,
  decode: (result: Readonly<Record<string, string>>) => T | Promise<T>,
  attempt: () => Promise<Result<T, WalletFailure>>,
): Promise<Result<T, WalletFailure>> {
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (isKeyConflict(error)) {
        return deps.unitOfWork.run<T, WalletFailure>(
          context.market,
          async () =>
            (await replayOf(deps, context, key, fingerprint, decode)) ??
            err({ code: 'wallet.unavailable' } as const),
          { readOnly: true },
        );
      }
      if (isStatusFence(error) && tries === 0) continue;
      throw error;
    }
  }
}

async function internalIds(
  deps: WalletDependencies,
  context: CallContext,
  kinds: readonly InternalAccountKind[],
  currency: string,
  now: Temporal.Instant,
) {
  return deps.wallet.ensureInternalAccounts(context.market, kinds, {
    newId: () => deps.ids.next<'WalletAccount'>(),
    currency,
    now,
  });
}

export const accountGate = (wallet: WalletAccountRecord, currency: string): WalletFailure | null =>
  wallet.currency !== currency
    ? { code: 'wallet.unavailable' }
    : wallet.status === 'active'
      ? null
      : { code: 'wallet.account-not-active' };

/** What a grant writes, once validated: the same for the facade and for admin issuance. */
export interface GrantPlan {
  readonly customer: Id<'Account'>;
  readonly source: 'promo' | 'refund';
  readonly amount: bigint;
  readonly reasonCode: string;
  readonly orderId: Id<'Order'> | null;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly now: Temporal.Instant;
  readonly policy: WalletSettings;
}

/** The first answer of a grant, rebuilt from its journal's stored result. */
const grantDecoder =
  (currency: string) =>
  (r: Readonly<Record<string, string>>): GrantCreditResult => ({
    journalId: r.journalId as Id<'WalletJournal'>,
    lotId: r.lotId as Id<'WalletLot'>,
    balance: {
      available: money(BigInt(r.availableMinor!), currency),
      held: money(BigInt(r.heldMinor!), currency),
    },
  });

/**
 * The grant inside the caller's open unit: the wallet's balance lock, the replay of a known key,
 * the switch, the customer wallet's state and the Market's balance cap, then one journal, one lot
 * and the new balance. `beforeWrite` runs after every check and before the first ledger row (the
 * admin flows spend their step-up proof there); its refusal ends the grant, and the caller's unit
 * then commits nothing.
 */
export async function grantInUnit<F = never>(
  deps: WalletDependencies,
  context: CallContext,
  plan: GrantPlan,
  beforeWrite?: () => Promise<F | null>,
): Promise<Result<GrantCreditResult, WalletFailure | F>> {
  const { customer, amount, policy, now } = plan;
  const decode = grantDecoder(policy.currency);
  let wallet = await deps.wallet.findWallet(context.market, customer);
  let balance: BalanceRecord | null = null;
  if (wallet !== null) balance = await deps.wallet.lockBalance(context.market, wallet.id);
  // The key is unique in the Market, so it is looked up even where this customer has no wallet.
  // A retry with a known key gets its first answer whatever the switch says now: the journal is
  // looked up, under the balance lock, before the gate. Only new work meets the gate.
  const replay = await replayOf(deps, context, plan.idempotencyKey, plan.fingerprint, decode);
  if (replay !== null) return replay;
  const closed = await gate(deps, context, 'grant');
  if (closed !== null) return err(closed);
  if (wallet === null || balance === null) {
    wallet = await deps.wallet.ensureWallet(context.market, {
      newAccountId: deps.ids.next<'WalletAccount'>(),
      customerAccountId: customer,
      currency: policy.currency,
      now,
    });
    balance = await deps.wallet.lockBalance(context.market, wallet.id);
    // A parallel request with the same key may have created the wallet and finished first.
    const raced = await replayOf(deps, context, plan.idempotencyKey, plan.fingerprint, decode);
    if (raced !== null) return raced;
  }
  const notActive = accountGate(wallet, policy.currency);
  if (notActive !== null) return err(notActive);
  if (balance.availableMinor + balance.heldMinor + amount > policy.balanceCapMinor) {
    return err({ code: 'wallet.cap-exceeded' });
  }
  if (beforeWrite !== undefined) {
    const refused = await beforeWrite();
    if (refused !== null) return err(refused);
  }

  const sourceKind = plan.source === 'promo' ? 'promo_expense' : 'refund_clearing';
  const accounts = await internalIds(deps, context, [sourceKind], policy.currency, now);
  const source = accounts.get(sourceKind)!;
  const journalId = deps.ids.next<'WalletJournal'>();
  const lotId = deps.ids.next<'WalletLot'>();
  const next = { ...balance, availableMinor: balance.availableMinor + amount };
  const kind: JournalKind = plan.source === 'promo' ? 'grant-promo' : 'grant-refund';
  await deps.wallet.appendJournal(context.market, {
    id: journalId,
    kind,
    holdId: null,
    lotId: null,
    idempotencyKey: plan.idempotencyKey,
    fingerprint: plan.fingerprint,
    actor: actorOf(context),
    reasonCode: plan.reasonCode,
    orderId: plan.orderId,
    walletAccountId: wallet.id,
    currency: policy.currency,
    createdAt: now,
    result: {
      journalId,
      lotId,
      availableMinor: next.availableMinor.toString(),
      heldMinor: next.heldMinor.toString(),
    },
    postings: [
      { accountId: wallet.id, amountMinor: amount },
      { accountId: source, amountMinor: -amount },
    ],
  });
  await deps.wallet.createLot(context.market, {
    id: lotId,
    walletAccountId: wallet.id,
    source: plan.source,
    journalId,
    amountMinor: amount,
    currency: policy.currency,
    expiresAt:
      plan.source === 'promo' ? promoExpiry(now, policy.promoExpiryMonths, policy.timeZone) : null,
    createdAt: now,
  });
  await deps.wallet.saveBalance(context.market, next, now);
  return ok({ journalId, lotId, balance: balanceOfRecord(next, policy.currency) });
}

/** Grants store credit (a lot) to a customer wallet, within the Market cap. */
export async function grantCredit(
  deps: WalletDependencies,
  context: CallContext,
  request: GrantCreditRequest,
): Promise<Result<GrantCreditResult, WalletFailure>> {
  const policy = deps.policy.settings(context.market);
  if (policy === null) return err({ code: 'wallet.unavailable' });
  const problems: Problem[] = [];
  const customer = idOf<'Account'>(request?.customerAccountId);
  if (customer === null) problems.push({ path: 'customerAccountId', code: 'format' });
  if (request?.source !== 'promo' && request?.source !== 'refund') {
    problems.push({ path: 'source', code: 'value' });
  }
  if (amountProblem(request?.amount, policy.currency))
    problems.push({ path: 'amount', code: 'range' });
  if (typeof request?.reasonCode !== 'string' || !REASON.test(request.reasonCode)) {
    problems.push({ path: 'reasonCode', code: 'format' });
  }
  const orderId = request?.orderId === undefined ? null : idOf<'Order'>(request.orderId);
  if (request?.orderId !== undefined && orderId === null)
    problems.push({ path: 'orderId', code: 'format' });
  if (!keyOk(request?.idempotencyKey)) problems.push({ path: 'idempotencyKey', code: 'format' });
  if (problems.length > 0 || customer === null) return err(invalid(problems));

  const amount = request.amount.amount;
  const fingerprint = [
    'grant',
    customer,
    request.source,
    amount,
    request.amount.currency,
    request.reasonCode,
    orderId ?? '',
  ].join('|');
  const plan: GrantPlan = {
    customer,
    source: request.source,
    amount,
    reasonCode: request.reasonCode,
    orderId,
    idempotencyKey: request.idempotencyKey,
    fingerprint,
    now: deps.clock.now(),
    policy,
  };
  const attempt = () =>
    deps.unitOfWork.run<GrantCreditResult, WalletFailure>(context.market, () =>
      grantInUnit(deps, context, plan),
    );
  return guarded(
    deps,
    context,
    request.idempotencyKey,
    fingerprint,
    grantDecoder(policy.currency),
    attempt,
  );
}

/** Sets `amount` aside for an order, taking the soonest-expiring lots first. */
export async function placeHold(
  deps: WalletDependencies,
  context: CallContext,
  request: PlaceHoldRequest,
): Promise<Result<HoldResult, WalletFailure>> {
  const policy = deps.policy.settings(context.market);
  if (policy === null) return err({ code: 'wallet.unavailable' });
  const now = deps.clock.now();
  const problems: Problem[] = [];
  const customer = idOf<'Account'>(request?.customerAccountId);
  if (customer === null) problems.push({ path: 'customerAccountId', code: 'format' });
  const orderId = idOf<'Order'>(request?.orderId);
  if (orderId === null) problems.push({ path: 'orderId', code: 'format' });
  if (amountProblem(request?.amount, policy.currency))
    problems.push({ path: 'amount', code: 'range' });
  const expiresAt = request?.expiresAt;
  if (
    typeof expiresAt?.epochMilliseconds !== 'number' ||
    expiresAt.epochMilliseconds <= now.epochMilliseconds
  ) {
    problems.push({ path: 'expiresAt', code: 'range' });
  }
  if (!keyOk(request?.idempotencyKey)) problems.push({ path: 'idempotencyKey', code: 'format' });
  if (problems.length > 0 || customer === null || orderId === null) return err(invalid(problems));

  const amount = request.amount.amount;
  const fingerprint = [
    'hold',
    customer,
    orderId,
    amount,
    request.amount.currency,
    request.expiresAt.epochMilliseconds,
  ].join('|');
  // The replay answers with the hold's state now, not the state it had when first placed.
  const decode = async (r: Readonly<Record<string, string>>): Promise<HoldResult> => ({
    holdId: r.holdId as Id<'WalletHold'>,
    journalId: r.journalId as Id<'WalletJournal'>,
    amount: money(BigInt(r.amountMinor!), policy.currency),
    status:
      (await deps.wallet.findHoldById(context.market, r.holdId as Id<'WalletHold'>))?.status ??
      'held',
  });
  const attempt = () =>
    deps.unitOfWork.run<HoldResult, WalletFailure>(context.market, async () => {
      const wallet = await deps.wallet.findWallet(context.market, customer);
      // Replay before the gate, under the balance lock (see grantCredit).
      const balance =
        wallet === null ? null : await deps.wallet.lockBalance(context.market, wallet.id);
      const replay = await replayOf(deps, context, request.idempotencyKey, fingerprint, decode);
      if (replay !== null) return replay;
      const closed = await gate(deps, context, 'hold');
      if (closed !== null) return err(closed);
      if (wallet === null || balance === null) return err({ code: 'wallet.insufficient-funds' });
      const notActive = accountGate(wallet, policy.currency);
      if (notActive !== null) return err(notActive);
      if ((await deps.wallet.findHold(context.market, orderId)) !== null) {
        return err({ code: 'wallet.hold-exists' });
      }
      const lots = await deps.wallet.lotsWithCredit(context.market, wallet.id);
      const takes = amount <= balance.availableMinor ? allocate(lots, amount, now) : null;
      if (takes === null) return err({ code: 'wallet.insufficient-funds' });

      const accounts = await internalIds(deps, context, ['holds'], policy.currency, now);
      const holdsAccount = accounts.get('holds')!;
      const journalId = deps.ids.next<'WalletJournal'>();
      const holdId = deps.ids.next<'WalletHold'>();
      const next = {
        ...balance,
        availableMinor: balance.availableMinor - amount,
        heldMinor: balance.heldMinor + amount,
      };
      await deps.wallet.appendJournal(context.market, {
        id: journalId,
        kind: 'hold',
        holdId,
        lotId: null,
        idempotencyKey: request.idempotencyKey,
        fingerprint,
        actor: actorOf(context),
        reasonCode: 'order-hold',
        orderId,
        walletAccountId: wallet.id,
        currency: policy.currency,
        createdAt: now,
        result: { journalId, holdId, amountMinor: amount.toString() },
        postings: [
          { accountId: wallet.id, amountMinor: -amount },
          { accountId: holdsAccount, amountMinor: amount },
        ],
      });
      await deps.wallet.createHold(
        context.market,
        {
          id: holdId,
          walletAccountId: wallet.id,
          orderId,
          amountMinor: amount,
          status: 'held',
          expiresAt: request.expiresAt,
          currency: policy.currency,
          createdAt: now,
        },
        takes,
      );
      const byId = new Map(lots.map((lot) => [lot.id, lot]));
      for (const take of takes) {
        await deps.wallet.setLotRemaining(
          context.market,
          take.lotId,
          byId.get(take.lotId)!.remaining - take.amount,
        );
      }
      await deps.wallet.saveBalance(context.market, next, now);
      return ok({ holdId, journalId, amount: money(amount, policy.currency), status: 'held' });
    });
  return guarded(deps, context, request.idempotencyKey, fingerprint, decode, attempt);
}

/**
 * Gives a held hold back to its lots and the available balance: the release of an order and the
 * expiry of an unsettled hold. Runs inside the unit that holds the balance lock.
 */
export async function releaseInUnit(
  deps: WalletDependencies,
  context: CallContext,
  input: {
    readonly hold: HoldRecord;
    readonly balance: BalanceRecord;
    readonly status: 'released' | 'expired';
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly reasonCode: string;
    readonly currency: string;
    readonly now: Temporal.Instant;
  },
): Promise<HoldResult> {
  const { hold, balance, now } = input;
  const accounts = await internalIds(deps, context, ['holds'], input.currency, now);
  const holdsAccount = accounts.get('holds')!;
  const journalId = deps.ids.next<'WalletJournal'>();
  const next = {
    ...balance,
    availableMinor: balance.availableMinor + hold.amountMinor,
    heldMinor: balance.heldMinor - hold.amountMinor,
  };
  await deps.wallet.appendJournal(context.market, {
    id: journalId,
    kind: 'release',
    holdId: hold.id,
    lotId: null,
    idempotencyKey: input.idempotencyKey,
    fingerprint: input.fingerprint,
    actor: actorOf(context),
    reasonCode: input.reasonCode,
    orderId: hold.orderId,
    walletAccountId: hold.walletAccountId,
    currency: input.currency,
    createdAt: now,
    result: { journalId, holdId: hold.id, amountMinor: hold.amountMinor.toString() },
    postings: [
      { accountId: holdsAccount, amountMinor: -hold.amountMinor },
      { accountId: hold.walletAccountId, amountMinor: hold.amountMinor },
    ],
  });
  // The hold leaves `held` first: the lot guard only lets credit come back for a settled hold.
  await deps.wallet.settleHold(context.market, hold.id, input.status, now);
  for (const take of await deps.wallet.holdLots(context.market, hold.id)) {
    const lot = await deps.wallet.findLot(context.market, take.lotId);
    await deps.wallet.setLotRemaining(context.market, take.lotId, lot!.remaining + take.amount);
  }
  await deps.wallet.saveBalance(context.market, next, now);
  return {
    holdId: hold.id,
    journalId,
    amount: money(hold.amountMinor, input.currency),
    status: 'released',
  };
}

type Settle = 'capture' | 'release';

async function settleHold(
  deps: WalletDependencies,
  context: CallContext,
  request: SettleHoldRequest,
  how: Settle,
): Promise<Result<HoldResult, WalletFailure>> {
  const policy = deps.policy.settings(context.market);
  if (policy === null) return err({ code: 'wallet.unavailable' });
  const problems: Problem[] = [];
  const customer = idOf<'Account'>(request?.customerAccountId);
  if (customer === null) problems.push({ path: 'customerAccountId', code: 'format' });
  const orderId = idOf<'Order'>(request?.orderId);
  if (orderId === null) problems.push({ path: 'orderId', code: 'format' });
  if (!keyOk(request?.idempotencyKey)) problems.push({ path: 'idempotencyKey', code: 'format' });
  if (problems.length > 0 || customer === null || orderId === null) return err(invalid(problems));

  const fingerprint = [how, customer, orderId].join('|');
  const now = deps.clock.now();
  const decode = (r: Readonly<Record<string, string>>): HoldResult => ({
    holdId: r.holdId as Id<'WalletHold'>,
    journalId: r.journalId as Id<'WalletJournal'>,
    amount: money(BigInt(r.amountMinor!), policy.currency),
    status: how === 'capture' ? 'captured' : 'released',
  });
  const attempt = () =>
    deps.unitOfWork.run<HoldResult, WalletFailure>(context.market, async () => {
      const wallet = await deps.wallet.findWallet(context.market, customer);
      // Replay before the gate, under the balance lock (see grantCredit).
      const balance =
        wallet === null ? null : await deps.wallet.lockBalance(context.market, wallet.id);
      const replay = await replayOf(deps, context, request.idempotencyKey, fingerprint, decode);
      if (replay !== null) return replay;
      const closed = await gate(deps, context, how);
      if (closed !== null) return err(closed);
      if (wallet === null || balance === null) return err({ code: 'wallet.not-found' });
      const hold = await deps.wallet.findHold(context.market, orderId, wallet.id);
      if (hold === null) return err({ code: 'wallet.not-found' });
      if (hold.status !== 'held') return err({ code: 'wallet.hold-not-held' });
      // A hold past its expiry is not captured while the sweep has not yet released it.
      if (how === 'capture' && hold.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
        return err({ code: 'wallet.hold-expired' });
      }

      if (how === 'release') {
        const released = await releaseInUnit(deps, context, {
          hold,
          balance,
          status: 'released',
          idempotencyKey: request.idempotencyKey,
          fingerprint,
          reasonCode: 'order-release',
          currency: policy.currency,
          now,
        });
        return ok(released);
      }
      const accounts = await internalIds(
        deps,
        context,
        ['holds', 'order_clearing'],
        policy.currency,
        now,
      );
      const journalId = deps.ids.next<'WalletJournal'>();
      await deps.wallet.appendJournal(context.market, {
        id: journalId,
        kind: 'capture',
        holdId: hold.id,
        lotId: null,
        idempotencyKey: request.idempotencyKey,
        fingerprint,
        actor: actorOf(context),
        reasonCode: 'order-capture',
        orderId,
        walletAccountId: wallet.id,
        currency: policy.currency,
        createdAt: now,
        result: { journalId, holdId: hold.id, amountMinor: hold.amountMinor.toString() },
        postings: [
          { accountId: accounts.get('holds')!, amountMinor: -hold.amountMinor },
          { accountId: accounts.get('order_clearing')!, amountMinor: hold.amountMinor },
        ],
      });
      await deps.wallet.settleHold(context.market, hold.id, 'captured', now);
      await deps.wallet.saveBalance(
        context.market,
        { ...balance, heldMinor: balance.heldMinor - hold.amountMinor },
        now,
      );
      return ok({
        holdId: hold.id,
        journalId,
        amount: money(hold.amountMinor, policy.currency),
        status: 'captured',
      });
    });
  return guarded(deps, context, request.idempotencyKey, fingerprint, decode, attempt);
}

export const captureHold = (
  deps: WalletDependencies,
  context: CallContext,
  request: SettleHoldRequest,
) => settleHold(deps, context, request, 'capture');

export const releaseHold = (
  deps: WalletDependencies,
  context: CallContext,
  request: SettleHoldRequest,
) => settleHold(deps, context, request, 'release');

/** A customer's balance for a system caller. Never created, never gated by the switch. */
export async function balanceOf(
  deps: WalletDependencies,
  context: CallContext,
  customerAccountId: Id<'Account'>,
): Promise<Result<WalletBalanceView, WalletFailure>> {
  const policy = deps.policy.settings(context.market);
  if (policy === null) return err({ code: 'wallet.unavailable' });
  const customer = idOf<'Account'>(customerAccountId);
  if (customer === null) return err(invalid([{ path: 'customerAccountId', code: 'format' }]));
  return deps.unitOfWork.run<WalletBalanceView, WalletFailure>(
    context.market,
    async () => {
      const setting = await deps.settings.find(context.market);
      const wallet = await deps.wallet.findWallet(context.market, customer);
      const balance =
        wallet === null
          ? { availableMinor: 0n, heldMinor: 0n }
          : await deps.wallet.readBalance(context.market, wallet.id);
      return ok({
        ...balanceOfRecord(
          { walletAccountId: wallet?.id ?? ('' as Id<'WalletAccount'>), ...balance },
          policy.currency,
        ),
        marketStatus: setting?.status ?? 'off',
      });
    },
    { readOnly: true },
  );
}
