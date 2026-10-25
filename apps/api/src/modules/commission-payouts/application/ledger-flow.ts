import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { PaidSellerOrder, RefundedSellerOrder } from '../contracts/commission-payouts.facade';
import { commissionBase, commissionOn, isRateBps } from '../domain/commission';
import {
  isCredit,
  totalsOf,
  type LedgerEntry,
  type LedgerKind,
  type LedgerTotals,
} from '../domain/ledger';
import { reverseLine, reverseShipping } from '../domain/reversal';
import type { CommissionPayoutsDependencies } from './commission-payouts-dependencies';
import type { LedgerPage } from './ports/ledger.repository';
import { sellerIdOf } from './rate-flow';

// The seller ledger (Phase 5 package 5): when a seller order is paid, one `sale` row per line,
// one `commission` row per line (on the line amount without GST, at the rate frozen at
// placement) and one `shipping` row for a non-zero delivery fee. Rows are only ever inserted.
// The seller sees its own ledger; an admin sees any seller's of the Market.
// Package 6a: a succeeded refund the seller bears adds reversal rows (`refund-sale`,
// `refund-commission` per refunded line, `refund-shipping` for a shipping part), each worked out
// from the stored rows of the seller order, never from a price. A refund the platform bears
// posts nothing (owner decision Q-O2).

export type LedgerFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'commission-payouts.rate-unavailable' }
  /** The stored rows of the seller order are missing or do not fit the refund: nothing is posted. */
  | { readonly code: 'commission-payouts.ledger-inconsistent' };

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
/** The most lines one seller order may bring (ordering caps a cart well below this). */
const MAX_LINES = 500;

export interface LedgerEntryView {
  readonly entryId: Id<'LedgerEntry'>;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly orderLineId: Id<'OrderLine'> | null;
  readonly kind: LedgerKind;
  readonly direction: 'credit' | 'debit';
  readonly amount: bigint;
  readonly rateBps: number | null;
  readonly baseAmount: bigint | null;
  /** The refund (or dispute) a reversal row comes from; null for the original kinds. */
  readonly sourceId: string | null;
  readonly occurredAt: Temporal.Instant;
  readonly recordedAt: Temporal.Instant;
}

export interface LedgerView {
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  readonly totals: LedgerTotals;
  readonly entries: readonly LedgerEntryView[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

/** A page cursor is `<recorded-at ms>.<entry id>`: opaque to callers, checked on the way in. */
const encodeCursor = (recordedAt: Temporal.Instant, id: string): string =>
  `${recordedAt.epochMilliseconds}.${id}`;

function decodeCursor(value: string): LedgerPage['after'] | undefined {
  const match = /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value);
  const id = match === null ? null : parseId<'LedgerEntry'>(match[2]!);
  if (match === null || id === null || !id.ok) return undefined;
  return { recordedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])), id: id.value };
}

export interface PageInput {
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

function pageOf(input: PageInput | undefined): Result<LedgerPage, LedgerFailure> {
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
  let after: LedgerPage['after'] = null;
  if (input?.cursor !== undefined) {
    const decoded = typeof input.cursor === 'string' ? decodeCursor(input.cursor) : undefined;
    if (decoded === undefined) fields.push({ path: 'cursor', code: 'format' });
    else after = decoded;
  }
  return fields.length > 0 ? err({ code: 'validation.failed', fields }) : ok({ limit, after });
}

const view = (entry: LedgerEntry): LedgerEntryView => ({
  entryId: entry.id,
  orderId: entry.orderId,
  sellerOrderId: entry.sellerOrderId,
  orderLineId: entry.orderLineId,
  kind: entry.kind,
  direction: isCredit(entry.kind) ? 'credit' : 'debit',
  amount: entry.amount.amount,
  rateBps: entry.rateBps,
  baseAmount: entry.baseAmount,
  sourceId: entry.sourceId,
  occurredAt: entry.occurredAt,
  recordedAt: entry.recordedAt,
});

async function readLedger(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
  input: PageInput | undefined,
): Promise<Result<LedgerView, LedgerFailure>> {
  const page = pageOf(input);
  if (!page.ok) return page;
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'commission-payouts.rate-unavailable' });
  const currency = settings.currency;
  return deps.unitOfWork.run<LedgerView, LedgerFailure>(
    context.market,
    async () => {
      const rows = await deps.ledger.list(context.market, sellerId, {
        limit: page.value.limit + 1,
        after: page.value.after,
      });
      const sums = await deps.ledger.sums(context.market, sellerId);
      const byKind: Partial<Record<LedgerKind, bigint>> = {};
      for (const sum of sums) if (sum.currency === currency) byKind[sum.kind] = sum.amount;
      const entries = rows.slice(0, page.value.limit);
      const last = entries[entries.length - 1];
      return ok({
        sellerId,
        currency,
        totals: totalsOf(byKind),
        entries: entries.map(view),
        nextCursor:
          rows.length > page.value.limit && last !== undefined
            ? encodeCursor(last.recordedAt, last.id)
            : null,
      });
    },
    { readOnly: true },
  );
}

/** The acting seller's own ledger and balance. */
export async function viewOwnLedger(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: PageInput,
): Promise<Result<LedgerView, LedgerFailure>> {
  const actor = context.actor;
  const sellerId =
    actor.kind === 'authenticated' && actor.population === 'seller'
      ? sellerIdOf(actor.sellerId)
      : null;
  if (sellerId === null) return err({ code: 'access.denied' });
  return readLedger(deps, context, sellerId, input);
}

/** An admin reads one seller's ledger and balance. An unknown seller has an empty ledger. */
export async function viewSellerLedger(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: PageInput & { readonly sellerId: unknown },
): Promise<Result<LedgerView, LedgerFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
  }
  return readLedger(deps, context, sellerId, input);
}

const idOf = <K extends string>(value: unknown): Id<K> | null => {
  const parsed = typeof value === 'string' ? parseId<K>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

const isAmount = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= 0n && value <= 9_000_000_000_000_000n;

/** Checks the facts ordering sends; anything malformed refuses the whole seller order. */
function checkPaid(paid: PaidSellerOrder, currency: string): readonly string[] {
  const bad: string[] = [];
  if (idOf(paid?.orderId) === null) bad.push('orderId');
  if (idOf(paid?.sellerOrderId) === null) bad.push('sellerOrderId');
  if (idOf(paid?.sellerId) === null) bad.push('sellerId');
  if (paid?.currency !== currency) bad.push('currency');
  if (!isAmount(paid?.shipping)) bad.push('shipping');
  if (!(paid?.paidAt instanceof Temporal.Instant)) bad.push('paidAt');
  const lines = paid?.lines;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES) {
    bad.push('lines');
    return bad;
  }
  const seen = new Set<string>();
  for (const line of lines as readonly PaidSellerOrder['lines'][number][]) {
    const lineId = idOf(line?.orderLineId);
    if (
      lineId === null ||
      seen.has(lineId) ||
      !isAmount(line.lineAmount) ||
      typeof line.taxInclusive !== 'boolean' ||
      !isRateBps(line.commissionRateBps)
    ) {
      bad.push('lines');
      break;
    }
    seen.add(lineId);
  }
  return bad;
}

/**
 * The system use case behind the facade: writes the ledger rows of one paid seller order, in one
 * unit. A seller order that already has rows writes nothing (`already-recorded`); the unique key
 * on (seller order, kind, line) is the second lock against a concurrent replay.
 */
export async function recordSellerOrderPaid(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  paid: PaidSellerOrder,
): Promise<Result<'recorded' | 'already-recorded', LedgerFailure>> {
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'commission-payouts.rate-unavailable' });
  const bad = checkPaid(paid, settings.currency);
  if (bad.length > 0) {
    return err({
      code: 'validation.failed',
      fields: bad.map((path) => ({ path, code: 'value' })),
    });
  }
  const now = deps.clock.now();
  const common = {
    sellerId: paid.sellerId,
    orderId: paid.orderId,
    sellerOrderId: paid.sellerOrderId,
    occurredAt: paid.paidAt,
    recordedAt: now,
  };
  const entries: LedgerEntry[] = [];
  for (const line of paid.lines) {
    // A fully discounted line earns nothing and owes nothing: it writes no rows.
    if (line.lineAmount === 0n) continue;
    entries.push({
      ...common,
      id: deps.ids.next<'LedgerEntry'>(),
      orderLineId: line.orderLineId,
      kind: 'sale',
      amount: money(line.lineAmount, paid.currency),
      rateBps: null,
      baseAmount: null,
      sourceId: null,
    });
    const base = commissionBase(line.lineAmount, line.taxInclusive, settings.provisionalTaxRateBps);
    entries.push({
      ...common,
      id: deps.ids.next<'LedgerEntry'>(),
      orderLineId: line.orderLineId,
      kind: 'commission',
      amount: money(commissionOn(base, line.commissionRateBps), paid.currency),
      rateBps: line.commissionRateBps,
      baseAmount: base,
      sourceId: null,
    });
  }
  if (paid.shipping > 0n) {
    entries.push({
      ...common,
      id: deps.ids.next<'LedgerEntry'>(),
      orderLineId: null,
      kind: 'shipping',
      amount: money(paid.shipping, paid.currency),
      rateBps: null,
      baseAmount: null,
      sourceId: null,
    });
  }
  return deps.unitOfWork.run<'recorded' | 'already-recorded', LedgerFailure>(
    context.market,
    async () => {
      if (await deps.ledger.hasSellerOrder(context.market, paid.sellerOrderId)) {
        return ok('already-recorded' as const);
      }
      const inserted = await deps.ledger.append(context.market, entries);
      return ok(inserted === 0 ? ('already-recorded' as const) : ('recorded' as const));
    },
  );
}

const MAX_LINE_QUANTITY = 999;
const LOSS_BEARERS: readonly string[] = ['seller', 'platform'];

/** Checks the facts ordering sends for a refund; anything malformed refuses the whole refund. */
function checkRefund(refund: RefundedSellerOrder, currency: string): readonly string[] {
  const bad: string[] = [];
  if (idOf(refund?.refundId) === null) bad.push('refundId');
  if (idOf(refund?.orderId) === null) bad.push('orderId');
  if (idOf(refund?.sellerOrderId) === null) bad.push('sellerOrderId');
  if (idOf(refund?.sellerId) === null) bad.push('sellerId');
  if (refund?.currency !== currency) bad.push('currency');
  if (!LOSS_BEARERS.includes(refund?.lossBearer)) bad.push('lossBearer');
  if (!(refund?.settledAt instanceof Temporal.Instant)) bad.push('settledAt');
  const lines = refund?.lines;
  if (!Array.isArray(lines) || lines.length > MAX_LINES) {
    bad.push('lines');
  } else {
    const seen = new Set<string>();
    for (const line of lines as readonly RefundedSellerOrder['lines'][number][]) {
      const lineId = idOf(line?.orderLineId);
      if (
        lineId === null ||
        seen.has(lineId) ||
        !Number.isSafeInteger(line.lineQuantity) ||
        line.lineQuantity < 1 ||
        line.lineQuantity > MAX_LINE_QUANTITY ||
        !Number.isSafeInteger(line.unitsBefore) ||
        line.unitsBefore < 0 ||
        !Number.isSafeInteger(line.units) ||
        line.units < 1 ||
        line.unitsBefore + line.units > line.lineQuantity
      ) {
        bad.push('lines');
        break;
      }
      seen.add(lineId);
    }
  }
  const shipping = refund?.shipping;
  if (shipping !== null && shipping !== undefined) {
    if (
      !isAmount(shipping.refundedBefore) ||
      !isAmount(shipping.refundedAfter) ||
      !isAmount(shipping.charge) ||
      shipping.refundedAfter <= shipping.refundedBefore ||
      shipping.refundedAfter > shipping.charge
    ) {
      bad.push('shipping');
    }
  } else if (shipping === undefined) bad.push('shipping');
  if (bad.length === 0 && refund.lines.length === 0 && (shipping ?? null) === null) {
    bad.push('lines');
  }
  return bad;
}

/**
 * The system use case behind the facade: writes the reversal rows of one succeeded refund, in one
 * unit. Seller-borne refunds only: `platform` posts nothing. Per refunded line a `refund-sale` and
 * a `refund-commission` row, for a shipping part a `refund-shipping` row, each the cumulative
 * proportional reversal of the stored row (see domain/reversal.ts). The rows are inserted with
 * ON CONFLICT DO NOTHING on (seller order, kind, line, refund), so a replay writes nothing.
 */
export async function recordRefund(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  refund: RefundedSellerOrder,
): Promise<Result<'recorded' | 'already-recorded' | 'nothing-to-post', LedgerFailure>> {
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'commission-payouts.rate-unavailable' });
  const bad = checkRefund(refund, settings.currency);
  if (bad.length > 0) {
    return err({
      code: 'validation.failed',
      fields: bad.map((path) => ({ path, code: 'value' })),
    });
  }
  // The platform bears the loss: the seller keeps its full share and the ledger is untouched.
  if (refund.lossBearer === 'platform') return ok('nothing-to-post' as const);
  const inconsistent = err({ code: 'commission-payouts.ledger-inconsistent' } as const);
  return deps.unitOfWork.run<'recorded' | 'already-recorded' | 'nothing-to-post', LedgerFailure>(
    context.market,
    async () => {
      const stored = await deps.ledger.listSellerOrder(context.market, refund.sellerOrderId);
      const original = (kind: LedgerKind, lineId: Id<'OrderLine'> | null) =>
        stored.find(
          (row) => row.kind === kind && row.orderLineId === lineId && row.sourceId === null,
        );
      if (
        stored.length === 0 ||
        stored.some((row) => row.sellerId !== refund.sellerId || row.orderId !== refund.orderId)
      ) {
        return inconsistent;
      }
      const common = {
        sellerId: refund.sellerId,
        orderId: refund.orderId,
        sellerOrderId: refund.sellerOrderId,
        sourceId: refund.refundId,
        occurredAt: refund.settledAt,
        recordedAt: deps.clock.now(),
      };
      const entries: LedgerEntry[] = [];
      for (const line of refund.lines) {
        const sale = original('sale', line.orderLineId);
        const commission = original('commission', line.orderLineId);
        // A line with no stored rows is refused, not skipped: a fully discounted line (which wrote
        // none) cannot be told from a line that is not on this seller order, and nothing is
        // guessed (Hassan L2).
        if (
          sale === undefined ||
          commission === undefined ||
          commission.rateBps === null ||
          commission.baseAmount === null
        ) {
          return inconsistent;
        }
        const reversed = reverseLine(
          {
            sale: sale.amount.amount,
            commission: commission.amount.amount,
            commissionBase: commission.baseAmount,
          },
          line.unitsBefore,
          line.units,
          line.lineQuantity,
        );
        // A sale row is never zero; a share that rounds to zero writes none (the commission row
        // below is still written, and may be zero).
        if (reversed.sale > 0n) {
          entries.push({
            ...common,
            id: deps.ids.next<'LedgerEntry'>(),
            orderLineId: line.orderLineId,
            kind: 'refund-sale',
            amount: money(reversed.sale, refund.currency),
            rateBps: null,
            baseAmount: null,
          });
        }
        entries.push({
          ...common,
          id: deps.ids.next<'LedgerEntry'>(),
          orderLineId: line.orderLineId,
          kind: 'refund-commission',
          amount: money(reversed.commission, refund.currency),
          rateBps: commission.rateBps,
          baseAmount: reversed.base,
        });
      }
      if (refund.shipping !== null) {
        const row = original('shipping', null);
        if (row === undefined) return inconsistent;
        const reversed = reverseShipping(
          row.amount.amount,
          refund.shipping.refundedBefore,
          refund.shipping.refundedAfter,
          refund.shipping.charge,
        );
        if (reversed > 0n) {
          entries.push({
            ...common,
            id: deps.ids.next<'LedgerEntry'>(),
            orderLineId: null,
            kind: 'refund-shipping',
            amount: money(reversed, refund.currency),
            rateBps: null,
            baseAmount: null,
          });
        }
      }
      // Defensive cap (Hassan L2): the reversals of the other refunds plus this one never pass the
      // stored row. A double reversal (a wrong unitsBefore, a repeated line) stops here.
      const reversedBefore = new Map<string, bigint>();
      for (const row of stored) {
        if (row.sourceId === null || row.sourceId === refund.refundId) continue;
        const key = `${row.kind}/${row.orderLineId ?? ''}`;
        reversedBefore.set(key, (reversedBefore.get(key) ?? 0n) + row.amount.amount);
      }
      const ORIGINAL_OF: Partial<Record<LedgerKind, LedgerKind>> = {
        'refund-sale': 'sale',
        'refund-commission': 'commission',
        'refund-shipping': 'shipping',
      };
      for (const entry of entries) {
        const row = original(ORIGINAL_OF[entry.kind]!, entry.orderLineId);
        const total =
          (reversedBefore.get(`${entry.kind}/${entry.orderLineId ?? ''}`) ?? 0n) +
          entry.amount.amount;
        if (row === undefined || total > row.amount.amount) return inconsistent;
      }
      if (entries.length === 0) return ok('nothing-to-post' as const);
      const inserted = await deps.ledger.append(context.market, entries);
      return ok(inserted === 0 ? ('already-recorded' as const) : ('recorded' as const));
    },
  );
}
