import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { PaidSellerOrder } from '../contracts/commission-payouts.facade';
import { commissionBase, commissionOn, isRateBps } from '../domain/commission';
import { totalsOf, type LedgerEntry, type LedgerKind, type LedgerTotals } from '../domain/ledger';
import type { CommissionPayoutsDependencies } from './commission-payouts-dependencies';
import type { LedgerPage } from './ports/ledger.repository';
import { sellerIdOf } from './rate-flow';

// The seller ledger (Phase 5 package 5): when a seller order is paid, one `sale` row per line,
// one `commission` row per line (on the line amount without GST, at the rate frozen at
// placement) and one `shipping` row for a non-zero delivery fee. Rows are only ever inserted.
// The seller sees its own ledger; an admin sees any seller's of the Market.

export type LedgerFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'commission-payouts.rate-unavailable' };

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
  direction: entry.kind === 'commission' ? 'debit' : 'credit',
  amount: entry.amount.amount,
  rateBps: entry.rateBps,
  baseAmount: entry.baseAmount,
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
      line.lineAmount === 0n ||
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
    entries.push({
      ...common,
      id: deps.ids.next<'LedgerEntry'>(),
      orderLineId: line.orderLineId,
      kind: 'sale',
      amount: money(line.lineAmount, paid.currency),
      rateBps: null,
      baseAmount: null,
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
