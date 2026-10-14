import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import { ACCOUNT_STATUSES, isPayoutReady, type AccountStatus } from '../domain/connected-account';
import { isCoolingOff } from '../domain/payout-change';
import { changesView, type PayoutChangeView } from './connect-flow';
import type { PaymentsDependencies } from './payments-dependencies';
import type { AccountPage, ConnectedAccountRecord } from './ports/connected-account-store';

// The admin's read-only view of the Market's connected accounts: state, waiting period and the
// kind and time of each bank change. No Stripe id, bank detail or requirement content.

/** A fixed page size. */
export const ADMIN_PAGE_SIZE = 25;

/** One connected account for the admin list and view. */
export interface ConnectedAccountRow {
  readonly sellerId: string;
  /** Null: no module offers the display name of a seller to payments yet. */
  readonly sellerName: string | null;
  readonly status: AccountStatus;
  readonly ready: boolean;
  readonly requirementsDue: number;
  readonly requirementsPastDue: boolean;
  readonly coolingOffUntil: Temporal.Instant | null;
  readonly payoutsPaused: boolean;
  readonly lastReadAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
}

export interface ConnectedAccountPage {
  readonly items: readonly ConnectedAccountRow[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

export interface ConnectedAccountDetail extends ConnectedAccountRow {
  /** Newest first, at most 10. */
  readonly changes: readonly PayoutChangeView[];
}

export type AdminAccountFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'payments.connected-account.not-found' };

/** A page cursor is `<created-at ms>.<seller id>`: opaque to callers, checked on the way in. */
export const encodeCursor = (createdAt: Temporal.Instant, sellerId: string): string =>
  `${createdAt.epochMilliseconds}.${sellerId}`;

function decodeCursor(value: string): AccountPage['after'] | undefined {
  const match = /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value);
  const id = match === null ? null : parseId<'Seller'>(match[2]!);
  if (match === null || id === null || !id.ok) return undefined;
  return {
    createdAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    sellerId: id.value,
  };
}

const isAdmin = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

function rowOf(record: ConnectedAccountRecord, now: Temporal.Instant): ConnectedAccountRow {
  return {
    sellerId: record.sellerId,
    sellerName: null,
    status: record.status,
    ready: isPayoutReady(record.status, record.coolingOffUntil, now),
    requirementsDue: record.requirementsDue,
    requirementsPastDue: record.requirementsPastDue,
    coolingOffUntil: isCoolingOff(record.coolingOffUntil, now) ? record.coolingOffUntil : null,
    payoutsPaused: isCoolingOff(record.payoutsPausedUntil, now),
    lastReadAt: record.lastReadAt,
    createdAt: record.createdAt,
  };
}

export async function listConnectedAccounts(
  deps: PaymentsDependencies,
  context: CallContext,
  input: { readonly status?: unknown; readonly cursor?: unknown },
): Promise<Result<ConnectedAccountPage, AdminAccountFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const fields: { path: string; code: string }[] = [];
  let status: AccountStatus | null = null;
  if (input?.status !== undefined) {
    if (ACCOUNT_STATUSES.includes(input.status as AccountStatus)) {
      status = input.status as AccountStatus;
    } else fields.push({ path: 'status', code: 'value' });
  }
  let after: AccountPage['after'] = null;
  if (input?.cursor !== undefined) {
    const decoded = typeof input.cursor === 'string' ? decodeCursor(input.cursor) : undefined;
    if (decoded === undefined) fields.push({ path: 'cursor', code: 'format' });
    else after = decoded;
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return deps.unitOfWork.run<ConnectedAccountPage, AdminAccountFailure>(
    context.market,
    async () => {
      const found = await deps.accounts.list(context.market, status, {
        limit: ADMIN_PAGE_SIZE,
        after,
      });
      const shown = found.slice(0, ADMIN_PAGE_SIZE);
      const last = shown[shown.length - 1];
      const now = deps.clock.now();
      return ok({
        items: shown.map((record) => rowOf(record, now)),
        nextCursor:
          found.length > ADMIN_PAGE_SIZE && last !== undefined
            ? encodeCursor(last.createdAt, last.sellerId)
            : null,
      });
    },
    { readOnly: true },
  );
}

export async function viewConnectedAccount(
  deps: PaymentsDependencies,
  context: CallContext,
  input: { readonly sellerId?: unknown },
): Promise<Result<ConnectedAccountDetail, AdminAccountFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const parsed = typeof input?.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
  if (parsed === null || !parsed.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] });
  }
  const sellerId = parsed.value;
  return deps.unitOfWork.run<ConnectedAccountDetail, AdminAccountFailure>(
    context.market,
    async () => {
      const record = await deps.accounts.find(context.market, sellerId);
      if (record === null) return err({ code: 'payments.connected-account.not-found' });
      return ok({
        ...rowOf(record, deps.clock.now()),
        changes: await changesView(deps, context, sellerId),
      });
    },
    { readOnly: true },
  );
}
