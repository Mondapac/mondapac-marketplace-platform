import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { PayoutApproved } from '../domain/audit';
import {
  approve,
  PAYOUT_STATES,
  type ApprovalReason,
  type BlockReason,
  type Payout,
  type PayoutItem,
  type PayoutState,
} from '../domain/payout';
import type { ApprovalMode } from '../domain/payout-terms';
import { COMMISSION_PAYOUTS_PAYOUT_APPROVE } from '../contracts/permissions';
import type { PayoutDependencies } from './payout-dependencies';
import { startOfMarketDay } from './payout-planning';
import type { PayoutPage } from './ports/payout.repository';
import { spendStepUp, type StepUpFailure } from './step-up';

// What an admin does with payouts (package 6d): list them, read one with what an approver needs,
// and approve one that waits. Approval marks the payout and binds the amount the admin saw; the
// worker, not this request, instructs the transfer.

type Fields = readonly { path: string; code: string }[];

export type PayoutFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: Fields }
  /** Unknown, or another Market's, payout: byte-identical. */
  | { readonly code: 'commission-payouts.payout-not-found' }
  | { readonly code: 'commission-payouts.payout.not-awaiting-approval' }
  /** The amount the admin echoed is not the transfer amount now. */
  | { readonly code: 'commission-payouts.payout.amount-changed' }
  | { readonly code: 'commission-payouts.unavailable' }
  | StepUpFailure;

export interface MoneyView {
  readonly amountMinor: bigint;
  readonly currency: string;
}

export interface PayoutRowView {
  readonly payoutId: Id<'Payout'>;
  readonly sellerId: Id<'Seller'>;
  readonly storeName: string | null;
  readonly state: PayoutState;
  readonly gross: MoneyView;
  readonly netted: MoneyView;
  readonly transfer: MoneyView;
  readonly approvalMode: ApprovalMode;
  readonly approvalReason: ApprovalReason | null;
  readonly slotAt: Temporal.Instant;
  readonly outcomeCode: string | null;
  readonly createdAt: Temporal.Instant;
  readonly stateChangedAt: Temporal.Instant;
}

export interface PayoutListView {
  readonly payouts: readonly PayoutRowView[];
  readonly nextCursor: string | null;
}

export interface PayoutDetailView extends PayoutRowView {
  readonly approval: {
    readonly approvedBy: Id<'Account'>;
    readonly approvedAt: Temporal.Instant;
    readonly approvedTransfer: MoneyView;
  } | null;
  readonly items: readonly {
    readonly sellerOrderId: Id<'SellerOrder'>;
    readonly amount: MoneyView;
  }[];
  /** From the seller's last payout evaluation; `unknown` before the first. */
  readonly accountReadiness: 'ready' | 'not-ready' | 'unknown';
  /** payments does not give the instant of the last bank change yet (an open item): always null. */
  readonly lastBankChangeAt: Temporal.Instant | null;
  readonly limits: {
    /** The most one transfer may be (Market config). */
    readonly perTransfer: MoneyView;
    /** What went to payments today (the Market's day) in all payouts. */
    readonly todayTotal: MoneyView;
    /** The daily total above which the platform alerts. */
    readonly dailyAlertLevel: MoneyView;
    readonly overDailyAlertLevel: boolean;
    readonly transferAboveLimit: boolean;
  } | null;
}

const adminOf = (context: CallContext) =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin'
    ? context.actor
    : null;

const moneyOf = (amountMinor: bigint, currency: string): MoneyView => ({ amountMinor, currency });

const rowOf = (payout: Payout, storeName: string | null): PayoutRowView => ({
  payoutId: payout.id,
  sellerId: payout.sellerId,
  storeName,
  state: payout.state,
  gross: moneyOf(payout.gross, payout.currency),
  netted: moneyOf(payout.netted, payout.currency),
  transfer: moneyOf(payout.transfer, payout.currency),
  approvalMode: payout.approvalMode,
  approvalReason: payout.approvalReason,
  slotAt: payout.slotAt,
  outcomeCode: payout.outcomeCode,
  createdAt: payout.createdAt,
  stateChangedAt: payout.stateChangedAt,
});

const idOf = <K extends string>(value: unknown): Id<K> | null => {
  const parsed = typeof value === 'string' ? parseId<K>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

export const PAYOUT_PAGE_DEFAULT = 50;
export const PAYOUT_PAGE_MAX = 100;

/** A page cursor is `<created-at ms>.<payout id>`: opaque to callers, checked on the way in. */
export const encodePayoutCursor = (createdAt: Temporal.Instant, id: string): string =>
  `${createdAt.epochMilliseconds}.${id}`;

export function decodePayoutCursor(value: string): PayoutPage['after'] | undefined {
  const match = /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value);
  const id = match === null ? null : idOf<'Payout'>(match[2]);
  if (match === null || id === null) return undefined;
  return { createdAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id };
}

/** The page of a list request: `limit` is a number, `cursor` the last page's `nextCursor`. */
export function pageOf(input: {
  readonly limit?: unknown;
  readonly cursor?: unknown;
}): Result<PayoutPage, PayoutFailure> {
  const fields: { path: string; code: string }[] = [];
  let limit = PAYOUT_PAGE_DEFAULT;
  if (input?.limit !== undefined) {
    if (
      typeof input.limit === 'number' &&
      Number.isSafeInteger(input.limit) &&
      input.limit >= 1 &&
      input.limit <= PAYOUT_PAGE_MAX
    ) {
      limit = input.limit;
    } else fields.push({ path: 'limit', code: 'range' });
  }
  let after: PayoutPage['after'] = null;
  if (input?.cursor !== undefined) {
    const decoded = typeof input.cursor === 'string' ? decodePayoutCursor(input.cursor) : undefined;
    if (decoded === undefined) fields.push({ path: 'cursor', code: 'format' });
    else after = decoded;
  }
  return fields.length > 0 ? err({ code: 'validation.failed', fields }) : ok({ limit, after });
}

/** The field errors of a refused page request. */
export const pageFields = (failure: PayoutFailure): Fields =>
  failure.code === 'validation.failed' ? failure.fields : [];

/** `status=awaiting-approval` or `AWAITING_APPROVAL`: the state names, in either spelling. */
function stateFilterOf(value: unknown): PayoutState | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const normal = value.toLowerCase().replaceAll('_', '-');
  return (PAYOUT_STATES as readonly string[]).includes(normal)
    ? (normal as PayoutState)
    : undefined;
}

/** An admin lists the Market's payouts, newest first, all or one state. */
export async function listPayouts(
  deps: PayoutDependencies,
  context: CallContext,
  input: { readonly status?: unknown; readonly cursor?: unknown; readonly limit?: unknown },
): Promise<Result<PayoutListView, PayoutFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const state = stateFilterOf(input?.status);
  const page = pageOf(input);
  const fields: { path: string; code: string }[] = [];
  if (state === undefined) fields.push({ path: 'status', code: 'value' });
  if (!page.ok) fields.push(...pageFields(page.error));
  if (state === undefined || !page.ok) return err({ code: 'validation.failed', fields });

  const rows = await deps.unitOfWork.run<readonly Payout[], PayoutFailure>(
    context.market,
    async () =>
      ok(
        await deps.payouts.list(
          context.market,
          { state },
          { ...page.value, limit: page.value.limit + 1 },
        ),
      ),
    { readOnly: true },
  );
  if (!rows.ok) return rows;
  const shown = rows.value.slice(0, page.value.limit);
  const names = await storeNames(deps, context, shown);
  const last = shown[shown.length - 1];
  return ok({
    payouts: shown.map((payout) => rowOf(payout, names.get(payout.sellerId) ?? null)),
    nextCursor:
      rows.value.length > page.value.limit && last !== undefined
        ? encodePayoutCursor(last.createdAt, last.id)
        : null,
  });
}

async function storeNames(
  deps: PayoutDependencies,
  context: CallContext,
  payouts: readonly Payout[],
): Promise<ReadonlyMap<Id<'Seller'>, string | null>> {
  const ids = [...new Set(payouts.map((payout) => payout.sellerId))];
  const names = ids.length === 0 ? new Map() : await deps.sellerNames.storeNames(context, ids);
  // A name that cannot be read degrades to the id; the payout is shown all the same.
  return names === 'unavailable' ? new Map() : names;
}

/** An admin reads one payout with its seller orders and what an approver needs to decide. */
export async function viewPayout(
  deps: PayoutDependencies,
  context: CallContext,
  input: { readonly payoutId: unknown },
): Promise<Result<PayoutDetailView, PayoutFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const payoutId = idOf<'Payout'>(input?.payoutId);
  if (payoutId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'payoutId', code: 'format' }] });
  }
  const market = context.market;
  const now = deps.clock.now();
  const limits = deps.payoutPolicy.limits(market);
  const found = await deps.unitOfWork.run<
    {
      readonly payout: Payout;
      readonly items: readonly PayoutItem[];
      readonly blockReason: BlockReason | null;
      readonly evaluated: boolean;
      readonly today: bigint;
    },
    PayoutFailure
  >(
    market,
    async () => {
      const stored = await deps.payouts.findWithItems(market, payoutId);
      if (stored === null) return err({ code: 'commission-payouts.payout-not-found' } as const);
      const cursor = await deps.cursors.find(market, stored.payout.sellerId);
      const today =
        limits === null
          ? 0n
          : await deps.payouts.sumTransferredSince(
              market,
              startOfMarketDay(deps.payoutPolicy.marketTimeZone(market), now),
            );
      return ok({
        ...stored,
        blockReason: cursor?.blockReason ?? null,
        evaluated: cursor?.evaluatedAt != null,
        today,
      });
    },
    { readOnly: true },
  );
  if (!found.ok) return found;
  const { payout, items, blockReason, evaluated, today } = found.value;
  const names = await storeNames(deps, context, [payout]);
  const currency = payout.currency;
  return ok({
    ...rowOf(payout, names.get(payout.sellerId) ?? null),
    approval:
      payout.approval === null
        ? null
        : {
            approvedBy: payout.approval.approvedBy,
            approvedAt: payout.approval.approvedAt,
            approvedTransfer: moneyOf(payout.approval.approvedTransfer, currency),
          },
    items: items.map((item) => ({
      sellerOrderId: item.sellerOrderId,
      amount: moneyOf(item.amount, currency),
    })),
    accountReadiness: !evaluated
      ? 'unknown'
      : blockReason === 'account-not-ready'
        ? 'not-ready'
        : 'ready',
    lastBankChangeAt: null,
    limits:
      limits === null || limits.currency !== currency
        ? null
        : {
            perTransfer: moneyOf(limits.maxTransferMinor, currency),
            todayTotal: moneyOf(today, currency),
            dailyAlertLevel: moneyOf(limits.dailyAlertMinor, currency),
            overDailyAlertLevel: today + payout.transfer > limits.dailyAlertMinor,
            transferAboveLimit: payout.transfer > limits.maxTransferMinor,
          },
  });
}

const AMOUNT = /^[0-9]{1,15}$/;

export interface ApprovedPayoutView {
  readonly payoutId: Id<'Payout'>;
  readonly state: PayoutState;
  readonly transfer: MoneyView;
  readonly approvedBy: Id<'Account'>;
  readonly approvedAt: Temporal.Instant;
}

/**
 * An admin approves a payout that waits for it, echoing the transfer amount they saw (minor units
 * as a string). A different amount is `amount-changed`: the payout was re-planned since. The
 * step-up proof is spent only when the approval is going to be written.
 */
export async function approvePayout(
  deps: PayoutDependencies,
  context: CallContext,
  input: { readonly payoutId: unknown; readonly amountMinor: unknown },
): Promise<Result<ApprovedPayoutView, PayoutFailure>> {
  const actor = adminOf(context);
  if (actor === null) return err({ code: 'access.denied' });
  const fields: { path: string; code: string }[] = [];
  const payoutId = idOf<'Payout'>(input?.payoutId);
  if (payoutId === null) fields.push({ path: 'payoutId', code: 'format' });
  const raw = input?.amountMinor;
  if (typeof raw !== 'string' || !AMOUNT.test(raw)) {
    fields.push({ path: 'amountMinor', code: typeof raw === 'string' ? 'format' : 'required' });
  }
  if (payoutId === null || fields.length > 0) return err({ code: 'validation.failed', fields });
  const echoed = BigInt(raw as string);

  const market = context.market;
  const now = deps.clock.now();
  return deps.unitOfWork.run<ApprovedPayoutView, PayoutFailure>(market, async () => {
    // The seller's money lock first, as every unit that moves a seller's money does.
    const first = await deps.payouts.find(market, payoutId);
    if (first === null) return err({ code: 'commission-payouts.payout-not-found' } as const);
    if ((await deps.cursors.lock(market, first.sellerId)) === null) {
      return err({ code: 'commission-payouts.payout-not-found' } as const);
    }
    const payout = await deps.payouts.find(market, payoutId);
    if (payout === null) return err({ code: 'commission-payouts.payout-not-found' } as const);
    const approved = approve(payout, echoed, actor.accountId, now);
    if (!approved.ok) return err(approved.error);
    const spent = await spendStepUp(deps, context, COMMISSION_PAYOUTS_PAYOUT_APPROVE.key);
    if (!spent.ok) return err(spent.error);
    if (!(await deps.payouts.change(market, payout, approved.value))) {
      return err({ code: 'commission-payouts.payout.not-awaiting-approval' } as const);
    }
    await deps.audit.record(
      context,
      PayoutApproved.entry(payout.id, {
        before: { state: 'awaiting-approval' },
        after: {
          sellerId: payout.sellerId,
          state: 'approved',
          transfer: money(payout.transfer, payout.currency),
          approvalReason: payout.approvalReason ?? 'terms',
        },
      }),
    );
    return ok({
      payoutId: payout.id,
      state: approved.value.state,
      transfer: moneyOf(payout.transfer, payout.currency),
      approvedBy: actor.accountId,
      approvedAt: now,
    });
  });
}
