import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { JournalKind } from './ports/wallet.repository';
import { refusalFor, type WalletStatus } from '../domain/wallet-status';
import type { WalletDependencies } from './wallet-dependencies';
import type { WalletFailure } from './wallet-flow';

// What the signed-in customer sees of their own wallet: the balance with the credit about to
// expire, and the history of what happened. Reads work while the wallet is paused or frozen (the
// customer still sees their money) and answer `wallet.disabled` only while it is off. Reading is
// allowed in an acting-as session (support may look, never spend; there is nothing to spend here).

export type CustomerWalletFailure = Extract<
  WalletFailure,
  { code: 'access.denied' | 'validation.failed' | 'wallet.disabled' | 'wallet.unavailable' }
>;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
const EXPIRING_LIMIT = 10;

export interface MyWalletView {
  readonly currency: string;
  readonly available: bigint;
  readonly held: bigint;
  readonly marketStatus: WalletStatus;
  /** Promo credit that expires within the Market's "soon" window, soonest first. */
  readonly expiringSoon: readonly {
    readonly expiresAt: Temporal.Instant;
    readonly amount: bigint;
  }[];
}

export interface HistoryEntryView {
  readonly journalId: Id<'WalletJournal'>;
  readonly kind: JournalKind;
  /** Signed: credit positive, spend negative. */
  readonly amount: bigint;
  readonly reasonCode: string;
  readonly orderId: Id<'Order'> | null;
  readonly createdAt: Temporal.Instant;
}

export interface HistoryView {
  readonly currency: string;
  readonly entries: readonly HistoryEntryView[];
  readonly nextCursor: string | null;
}

export interface HistoryInput {
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

const isCustomer = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' && context.actor.population === 'customer';

export async function viewMyWallet(
  deps: WalletDependencies,
  context: CallContext,
): Promise<Result<MyWalletView, CustomerWalletFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
    return err({ code: 'access.denied' });
  }
  const policy = deps.policy.settings(context.market);
  if (policy === null) return err({ code: 'wallet.unavailable' });
  const now = deps.clock.now();
  return deps.unitOfWork.run<MyWalletView, CustomerWalletFailure>(
    context.market,
    async () => {
      const setting = await deps.settings.find(context.market);
      const status = setting?.status ?? 'off';
      const refusal = refusalFor(status, 'read');
      if (refusal !== null) return err({ code: 'wallet.disabled' } as const);
      const wallet = await deps.wallet.findWallet(context.market, actor.accountId);
      if (wallet === null) {
        return ok({
          currency: policy.currency,
          available: 0n,
          held: 0n,
          marketStatus: status,
          expiringSoon: [],
        });
      }
      const balance = await deps.wallet.readBalance(context.market, wallet.id);
      const soon = now.add({ hours: policy.expiringSoonDays * 24 });
      const lots = await deps.wallet.expiringLots(
        context.market,
        wallet.id,
        soon,
        now,
        EXPIRING_LIMIT,
      );
      return ok({
        currency: policy.currency,
        available: balance.availableMinor,
        held: balance.heldMinor,
        marketStatus: status,
        expiringSoon: lots.map((lot) => ({ expiresAt: lot.expiresAt!, amount: lot.remaining })),
      });
    },
    { readOnly: true },
  );
}

const encodeCursor = (createdAt: Temporal.Instant, id: string): string =>
  `${createdAt.epochMilliseconds}.${id}`;

function decodeCursor(value: string) {
  const match = /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value);
  const id = match === null ? null : parseId<'WalletJournal'>(match[2]!);
  if (match === null || id === null || !id.ok) return undefined;
  return { createdAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: id.value };
}

export async function viewMyHistory(
  deps: WalletDependencies,
  context: CallContext,
  input: HistoryInput,
): Promise<Result<HistoryView, CustomerWalletFailure>> {
  const actor = context.actor;
  if (!isCustomer(context) || actor.kind !== 'authenticated') return err({ code: 'access.denied' });
  const fields: { path: string; code: string }[] = [];
  let limit = DEFAULT_PAGE_SIZE;
  if (input?.limit !== undefined) {
    if (
      typeof input.limit === 'number' &&
      Number.isSafeInteger(input.limit) &&
      input.limit >= 1 &&
      input.limit <= MAX_PAGE_SIZE
    ) {
      limit = input.limit;
    } else fields.push({ path: 'limit', code: 'range' });
  }
  let after: ReturnType<typeof decodeCursor> | null = null;
  if (input?.cursor !== undefined) {
    const decoded = typeof input.cursor === 'string' ? decodeCursor(input.cursor) : undefined;
    if (decoded === undefined) fields.push({ path: 'cursor', code: 'format' });
    else after = decoded;
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  const policy = deps.policy.settings(context.market);
  if (policy === null) return err({ code: 'wallet.unavailable' });
  return deps.unitOfWork.run<HistoryView, CustomerWalletFailure>(
    context.market,
    async () => {
      const setting = await deps.settings.find(context.market);
      if (refusalFor(setting?.status ?? 'off', 'read') !== null) {
        return err({ code: 'wallet.disabled' } as const);
      }
      const wallet = await deps.wallet.findWallet(context.market, actor.accountId);
      if (wallet === null) return ok({ currency: policy.currency, entries: [], nextCursor: null });
      const rows = await deps.wallet.history(context.market, wallet.id, {
        limit: limit + 1,
        after,
      });
      const entries = rows.slice(0, limit);
      const last = entries[entries.length - 1];
      return ok({
        currency: policy.currency,
        entries: entries.map((row) => ({
          journalId: row.journalId,
          kind: row.kind,
          amount: row.amountMinor,
          reasonCode: row.reasonCode,
          orderId: row.orderId,
          createdAt: row.createdAt,
        })),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor(last.createdAt, last.journalId)
            : null,
      });
    },
    { readOnly: true },
  );
}
