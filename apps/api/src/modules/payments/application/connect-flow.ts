import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import { isPayoutReady, type AccountStatus } from '../domain/connected-account';
import { isCoolingOff, type ChangeKind } from '../domain/payout-change';
import type { ConnectedAccountRecord } from './ports/connected-account-store';
import type { PaymentsDependencies } from './payments-dependencies';

/** A change of the payout destination as the seller and the admin see it: when and what kind. */
export interface PayoutChangeView {
  readonly detectedAt: Temporal.Instant;
  readonly kind: ChangeKind;
}

/** How many changes the answers list. */
export const CHANGES_SHOWN = 10;

/** What the seller panel shows about the payout account. */
export interface PayoutAccountView {
  /** `not-connected` before the seller has started; otherwise the stored status. */
  readonly status: AccountStatus | 'not-connected';
  /** Stripe can pay this seller and no bank-change waiting period is running. */
  readonly ready: boolean;
  /** How many items Stripe still wants from the seller (a count). */
  readonly requirementsDue: number;
  readonly requirementsPastDue: boolean;
  /** The signed-in Seller Owner has two-step sign-in on (needed to change the payout account). */
  readonly secondFactorActive: boolean;
  /** The end of the waiting period after a bank change, or null. */
  readonly coolingOffUntil: Temporal.Instant | null;
  /** Stripe payouts are paused for the waiting period. */
  readonly payoutsPaused: boolean;
  /** Newest first, at most {@link CHANGES_SHOWN}. */
  readonly changes: readonly PayoutChangeView[];
}

/** The body of the two write routes: a current two-step code (app or recovery code). */
export interface PayoutAccountInput {
  readonly code?: unknown;
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
  | { readonly code: 'payments.payout-account.rejected' }
  /** Changing the payout account needs two-step sign-in, and the seller has not turned it on. */
  | { readonly code: 'payments.payout-account.second-factor-required' }
  /** The code is wrong, missing or malformed. */
  | { readonly code: 'second-factor.invalid' }
  /** Too many wrong codes: wait. */
  | { readonly code: 'second-factor.locked'; readonly retryAfterSeconds: number };

/** A seller session: the seller id of the active membership, or null for any other actor. */
export function sellerIdOf(context: CallContext): string | null {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'seller' ? actor.sellerId : null;
}

export function notConnected(secondFactorActive: boolean): PayoutAccountView {
  return {
    status: 'not-connected',
    ready: false,
    requirementsDue: 0,
    requirementsPastDue: false,
    secondFactorActive,
    coolingOffUntil: null,
    payoutsPaused: false,
    changes: [],
  };
}

export function viewOf(
  record: ConnectedAccountRecord | null,
  changes: readonly PayoutChangeView[],
  secondFactorActive: boolean,
  now: Temporal.Instant,
): PayoutAccountView {
  if (record === null) return notConnected(secondFactorActive);
  return {
    status: record.status,
    ready: isPayoutReady(record.status, record.coolingOffUntil, now),
    requirementsDue: record.requirementsDue,
    requirementsPastDue: record.requirementsPastDue,
    secondFactorActive,
    coolingOffUntil: isCoolingOff(record.coolingOffUntil, now) ? record.coolingOffUntil : null,
    payoutsPaused: isCoolingOff(record.payoutsPausedUntil, now),
    changes,
  };
}

/** The seller's latest changes for an answer. Runs inside the caller's unit. */
export async function changesView(
  deps: PaymentsDependencies,
  context: CallContext,
  sellerId: string,
): Promise<readonly PayoutChangeView[]> {
  const rows = await deps.accounts.changesOf(context.market, sellerId, CHANGES_SHOWN);
  return rows.map((row) => ({ detectedAt: row.detectedAt, kind: row.kind }));
}

/** Stripe keeps an idempotency key 24 h; a create is repeated only well inside that time. */
const CREATE_KEY_HOURS = 23;

/** The key of the one create call of a seller: stored (the row) before Stripe is called. */
const creationKey = (marketId: string, sellerId: string): string =>
  `connected-account:${marketId}:${sellerId}`;

/** Whether the signed-in seller account has two-step sign-in on, from identity's facade. */
async function secondFactorActiveOf(
  deps: PaymentsDependencies,
  context: CallContext,
): Promise<Result<boolean, PayoutAccountFailure>> {
  const described = await deps.identity.describeActor(context);
  return described.ok ? ok(described.value.secondFactorActive) : err({ code: 'access.denied' });
}

/** `view-payout-account`: the seller's own account state, from the stored row only. */
export async function viewPayoutAccount(
  deps: PaymentsDependencies,
  context: CallContext,
): Promise<Result<PayoutAccountView, PayoutAccountFailure>> {
  const sellerId = sellerIdOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const factor = await secondFactorActiveOf(deps, context);
  if (!factor.ok) return factor;
  return deps.unitOfWork.run<PayoutAccountView, PayoutAccountFailure>(
    context.market,
    async () =>
      ok(
        viewOf(
          await deps.accounts.find(context.market, sellerId),
          await changesView(deps, context, sellerId),
          factor.value,
          deps.clock.now(),
        ),
      ),
    { readOnly: true },
  );
}

/**
 * `connect-payout-account` (creates the Stripe account when the seller has none) and
 * `open-payout-account-link` (needs the account): both end with a one-time hosted Stripe page, the
 * onboarding page. The row is stored
 * first, then Stripe is called once with the stored key, then the Stripe id is stored: a request
 * that dies half-way is repeated with the same key and finds the same account. The pages Stripe
 * returns the seller to come from Market config, never from the request. No Stripe call runs
 * inside a database transaction.
 */
export async function openPayoutAccountLink(
  deps: PaymentsDependencies,
  context: CallContext,
  create: boolean,
  input: { readonly code?: unknown },
): Promise<Result<PayoutAccountLink, PayoutAccountFailure>> {
  const sellerId = sellerIdOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const market = context.market;
  const country = deps.policy.connectedAccountCountry(market);
  const urls = deps.policy.onboardingUrls(market);
  if (country === null || urls === null) return err({ code: 'payments.unavailable' });

  // Recent confirmation: a current code of the seller's two-step sign-in, checked and spent before
  // any write or Stripe call. Without the factor the seller must turn it on first.
  const factor = await secondFactorActiveOf(deps, context);
  if (!factor.ok) return factor;
  if (!factor.value) return err({ code: 'payments.payout-account.second-factor-required' });
  if (typeof input?.code !== 'string') return err({ code: 'second-factor.invalid' });
  const confirmed = await deps.identity.confirmSecondFactor(context, input.code);
  if (!confirmed.ok) {
    const failure = confirmed.error;
    switch (failure.code) {
      case 'second-factor.locked':
        return err({ code: failure.code, retryAfterSeconds: failure.retryAfterSeconds });
      case 'second-factor.invalid':
      case 'validation.failed':
        return err({ code: 'second-factor.invalid' });
      case 'second-factor.unavailable':
        return err({ code: 'payments.payout-account.second-factor-required' });
      case 'access.unavailable':
        return err({ code: 'payments.unavailable' });
      default:
        return err({ code: 'access.denied' });
    }
  }

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
    // Stripe forgets an idempotency key after 24 h: past that, a repeat would create a second
    // account. Refuse and leave it to an admin instead.
    if (deps.clock.now().since(record.createdAt).total('hours') >= CREATE_KEY_HOURS) {
      return err({ code: 'payments.unavailable' });
    }
    // Stripe requires a contact email for the recipient configuration: the Seller Owner's own
    // verified address, sent to Stripe once and never logged or stored here.
    const contact = await deps.identity.ownOwnerEmail(context);
    if (!contact.ok || contact.value === null) return err({ code: 'payments.unavailable' });
    const created = await deps.connect.createAccount({
      idempotencyKey: creationKey(market.marketId, sellerId),
      country,
      marketId: market.marketId,
      sellerId,
      contactEmail: contact.value,
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
    // Express accounts have no `account_update` link; the onboarding page also lets an enabled
    // seller review the details.
    kind: 'onboarding',
    returnUrl: urls.returnUrl,
    refreshUrl: urls.refreshUrl,
  });
  if (!link.ok) return err({ code: 'payments.unavailable' });
  const answered = await deps.unitOfWork.run<PayoutAccountLink, PayoutAccountFailure>(
    market,
    async () =>
      ok({
        ...viewOf(record, await changesView(deps, context, sellerId), true, deps.clock.now()),
        url: link.value.url,
      }),
    { readOnly: true },
  );
  return answered;
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
 * `payout-readiness`: per seller id, whether the stored account is `enabled` and past any bank-change
 * waiting period. From the stored
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
      const records = await deps.accounts.recordsOf(context.market, sellerIds);
      const now = deps.clock.now();
      return ok(
        sellerIds.map((sellerId) => {
          const record = records.get(sellerId);
          return {
            sellerId,
            ready:
              record !== undefined && isPayoutReady(record.status, record.coolingOffUntil, now),
          };
        }),
      );
    },
    { readOnly: true },
  );
}
