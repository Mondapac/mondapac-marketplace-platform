import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import { isReady, type AccountStatus } from '../domain/connected-account';
import type { ConnectedAccountRecord } from './ports/connected-account-store';
import type { PaymentsDependencies } from './payments-dependencies';

/** What the seller panel shows about the payout account. */
export interface PayoutAccountView {
  /** `not-connected` before the seller has started; otherwise the stored status. */
  readonly status: AccountStatus | 'not-connected';
  /** Stripe can pay this seller. */
  readonly ready: boolean;
  /** How many items Stripe still wants from the seller (a count). */
  readonly requirementsDue: number;
  readonly requirementsPastDue: boolean;
}

export interface PayoutAccountLink extends PayoutAccountView {
  /** The one-time hosted Stripe page. Never stored or logged; the response is `no-store`. */
  readonly url: string;
}

export type PayoutAccountFailure =
  | AccessDenied
  /** Stripe or this Market's setup is not available: try again later. */
  | { readonly code: 'payments.unavailable' }
  /** `open-payout-account-link` before any account was created. */
  | { readonly code: 'payments.payout-account.not-found' }
  /** Stripe rejected the account: it cannot be used again. */
  | { readonly code: 'payments.payout-account.rejected' };

/** A seller session: the seller id of the active membership, or null for any other actor. */
export function sellerIdOf(context: CallContext): string | null {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'seller' ? actor.sellerId : null;
}

export const NOT_CONNECTED: PayoutAccountView = Object.freeze({
  status: 'not-connected' as const,
  ready: false,
  requirementsDue: 0,
  requirementsPastDue: false,
});

export function viewOf(record: ConnectedAccountRecord | null): PayoutAccountView {
  if (record === null) return NOT_CONNECTED;
  return {
    status: record.status,
    ready: isReady(record.status),
    requirementsDue: record.requirementsDue,
    requirementsPastDue: record.requirementsPastDue,
  };
}

/** The key of the one create call of a seller: stored (the row) before Stripe is called. */
const creationKey = (marketId: string, sellerId: string): string =>
  `connected-account:${marketId}:${sellerId}`;

/** `view-payout-account`: the seller's own account state, from the stored row only. */
export async function viewPayoutAccount(
  deps: PaymentsDependencies,
  context: CallContext,
): Promise<Result<PayoutAccountView, PayoutAccountFailure>> {
  const sellerId = sellerIdOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  return deps.unitOfWork.run<PayoutAccountView, PayoutAccountFailure>(
    context.market,
    async () => ok(viewOf(await deps.accounts.find(context.market, sellerId))),
    { readOnly: true },
  );
}

/**
 * `connect-payout-account` (creates the Stripe account when the seller has none) and
 * `open-payout-account-link` (needs the account): both end with a one-time hosted Stripe page, the
 * onboarding page until the account is enabled, the update page afterwards. The row is stored
 * first, then Stripe is called once with the stored key, then the Stripe id is stored: a request
 * that dies half-way is repeated with the same key and finds the same account. The pages Stripe
 * returns the seller to come from Market config, never from the request. No Stripe call runs
 * inside a database transaction.
 */
export async function openPayoutAccountLink(
  deps: PaymentsDependencies,
  context: CallContext,
  create: boolean,
): Promise<Result<PayoutAccountLink, PayoutAccountFailure>> {
  const sellerId = sellerIdOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const market = context.market;
  const country = deps.policy.connectedAccountCountry(market);
  const urls = deps.policy.onboardingUrls(market);
  if (country === null || urls === null) return err({ code: 'payments.unavailable' });

  let record: ConnectedAccountRecord | null;
  if (create) {
    const stored = await deps.unitOfWork.run<ConnectedAccountRecord | null, PayoutAccountFailure>(
      market,
      async () => {
        await deps.accounts.insert(market, sellerId, deps.clock.now());
        return ok(await deps.accounts.find(market, sellerId));
      },
    );
    if (!stored.ok) return stored;
    record = stored.value;
  } else {
    const stored = await deps.unitOfWork.run<ConnectedAccountRecord | null, PayoutAccountFailure>(
      market,
      async () => ok(await deps.accounts.find(market, sellerId)),
      { readOnly: true },
    );
    if (!stored.ok) return stored;
    record = stored.value;
  }
  if (record === null) return err({ code: 'payments.payout-account.not-found' });
  if (record.status === 'rejected') return err({ code: 'payments.payout-account.rejected' });

  let accountRef = record.accountRef;
  if (accountRef === null) {
    const created = await deps.connect.createAccount({
      idempotencyKey: creationKey(market.marketId, sellerId),
      country,
      marketId: market.marketId,
      sellerId,
    });
    if (!created.ok) return err({ code: 'payments.unavailable' });
    const linked = await deps.unitOfWork.run<string | null, PayoutAccountFailure>(
      market,
      async () => {
        await deps.accounts.linkRef(market, sellerId, created.value.accountRef, deps.clock.now());
        return ok((await deps.accounts.find(market, sellerId))?.accountRef ?? null);
      },
    );
    if (!linked.ok) return linked;
    // Another request may have stored its id first; with one key both ids are the same account.
    accountRef = linked.value;
    if (accountRef === null) return err({ code: 'payments.unavailable' });
    record = { ...record, accountRef };
  }

  const link = await deps.connect.createAccountLink({
    accountRef,
    kind: record.status === 'enabled' ? 'update' : 'onboarding',
    returnUrl: urls.returnUrl,
    refreshUrl: urls.refreshUrl,
  });
  if (!link.ok) return err({ code: 'payments.unavailable' });
  return ok({ ...viewOf(record), url: link.value.url });
}

/** What `payoutReadiness` answers for one seller. */
export interface PayoutReadiness {
  readonly sellerId: string;
  readonly ready: boolean;
}

export const MAX_READINESS_IDS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReadinessFailure = AccessDenied | { readonly code: 'validation.failed' };

/**
 * `payout-readiness`: per seller id, whether the stored account is `enabled`. From the stored
 * state only, no Stripe call. An unknown seller or one of another Market is `ready: false`; more
 * than {@link MAX_READINESS_IDS} ids are refused whole.
 */
export async function payoutReadiness(
  deps: PaymentsDependencies,
  context: CallContext,
  sellerIds: readonly string[],
): Promise<Result<readonly PayoutReadiness[], ReadinessFailure>> {
  const given: unknown = sellerIds;
  if (
    !Array.isArray(given) ||
    given.length > MAX_READINESS_IDS ||
    !given.every((id: unknown) => typeof id === 'string' && UUID.test(id))
  ) {
    return err({ code: 'validation.failed' });
  }
  return deps.unitOfWork.run<readonly PayoutReadiness[], ReadinessFailure>(
    context.market,
    async () => {
      const statuses = await deps.accounts.statusesOf(context.market, sellerIds);
      return ok(
        sellerIds.map((sellerId) => ({
          sellerId,
          ready: isReady(statuses.get(sellerId) ?? 'not-started'),
        })),
      );
    },
    { readOnly: true },
  );
}
