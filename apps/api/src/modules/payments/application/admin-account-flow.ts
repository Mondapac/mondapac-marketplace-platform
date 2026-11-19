import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import { isPayoutReady, type AccountStatus } from '../domain/connected-account';
import { isCoolingOff } from '../domain/payout-change';
import { changesView, type PayoutChangeView } from './connect-flow';
import type { PaymentsDependencies } from './payments-dependencies';
import type { ConnectedAccountRecord } from './ports/connected-account-store';

// The admin's read-only view of the Market's connected accounts: state, waiting period and the
// kind and time of each bank change. No Stripe id, bank detail or requirement content.

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
