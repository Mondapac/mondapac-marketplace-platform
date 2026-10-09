import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  SELLER_ACCESS_APPROVE,
  SELLER_ACCESS_SUSPEND,
  SELLER_ACCESS_VIEW,
  SELLER_ACCOUNT_CREATE,
} from '../../contracts/permissions';
import { parseEmailAddress } from '../../domain/email-address';
import { invitationStatusAt } from '../../domain/invitation';
import {
  SellerAccess,
  type SellerAccessStateCode,
  type SellerOrigin,
} from '../../domain/seller-access';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type {
  OpenSellerOwnerInvitation,
  SellerAccountReader,
  SellerAccountRecord,
} from '../ports/seller-account-reader';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { isActingAsSession } from '../sellers/access-decision-reads';
import { sellerAccessVerdict, type SellerAccessVerb } from '../sellers/seller-access-decision';
import { sellerInvitationResendVerdict } from '../sellers/seller-owner-invitation';
import type { ActionHint } from './list-admin-team.use-case';

/** The largest page of the admin seller list; the route's default page is smaller. */
export const MAX_SELLER_LIST_PAGE = 100;

/** The list's filters: the four access states, and the open owner invitations (`ux.md` P1 tabs). */
export const SELLER_LIST_FILTERS = [
  'pending',
  'approved',
  'rejected',
  'suspended',
  'invited',
] as const;
export type SellerListFilter = (typeof SELLER_LIST_FILTERS)[number];

export interface ListSellerAccountsInput {
  /** The last id of the previous page; absent or null for the first page. */
  readonly after?: string | null;
  readonly limit: number;
  /** One of {@link SELLER_LIST_FILTERS}; absent or null for every row ("All"). */
  readonly state?: string | null;
  /** An exact address (11.2): matched normalised, never logged or echoed. */
  readonly email?: string | null;
}

export interface SellerListOwner {
  readonly accountId: Id<'Account'>;
  readonly email: string;
  readonly displayName: string | null;
}

export interface SellerListSellerRow {
  readonly type: 'seller';
  readonly sellerId: Id<'Seller'>;
  readonly origin: SellerOrigin;
  readonly state: SellerAccessStateCode;
  /** "Since" (`ux.md` P1): the instant of the last change of state. */
  readonly stateChangedAt: Temporal.Instant;
  /**
   * Rejected with no re-application left ("Not approved" rather than "Changes needed"; Jafar 6),
   * as the status read; null while the Market configures no re-apply limit.
   */
  readonly reapplyLimitReached: boolean | null;
  readonly owner: SellerListOwner;
  readonly actions: {
    readonly approve: ActionHint;
    readonly reject: ActionHint;
    readonly suspend: ActionHint;
    readonly reinstate: ActionHint;
  };
}

export interface SellerListInvitationRow {
  readonly type: 'invitation';
  readonly invitationId: Id<'Invitation'>;
  readonly sellerId: Id<'Seller'>;
  readonly email: string;
  /** The name the admin gave (`ux.md` D6). */
  readonly displayName: string | null;
  /** `expired`: past the expiry of its last mail; it can be re-sent within its lifetime. */
  readonly status: 'pending' | 'expired';
  readonly createdAt: Temporal.Instant;
  /** Null until its mail is sent (and right after a re-send). */
  readonly expiresAt: Temporal.Instant | null;
  readonly actions: { readonly resend: ActionHint; readonly revoke: ActionHint };
}

export type SellerListRow = SellerListSellerRow | SellerListInvitationRow;

export interface SellerListPage {
  /** Sellers and open owner invitations, merged by id (UUID v7: creation order). */
  readonly items: readonly SellerListRow[];
  /** The `after` of the next page, or null when this page was the last. */
  readonly next: string | null;
}

export type ListSellerAccountsFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ListSellerAccountsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly sellerAccounts: SellerAccountReader;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

const USE_CASE = 'identity.list-seller-accounts';
const ALLOWED: ActionHint = Object.freeze({ allowed: true, code: null });
const denied = (code: string): ActionHint => Object.freeze({ allowed: false, code });
const hintOf = (result: Result<unknown, { readonly code: string }>): ActionHint =>
  result.ok ? ALLOWED : denied(result.error.code);

/** The key of each decision's command (identity design 5.3). */
const DECISION_KEY: Readonly<Record<SellerAccessVerb, string>> = Object.freeze({
  approve: SELLER_ACCESS_APPROVE.key,
  reject: SELLER_ACCESS_APPROVE.key,
  suspend: SELLER_ACCESS_SUSPEND.key,
  reinstate: SELLER_ACCESS_SUSPEND.key,
});

type ValidInput = {
  readonly after: string | null;
  readonly limit: number;
  readonly filter: SellerListFilter | null;
  readonly emailNormalized: string | null;
};

/**
 * The admin seller list (identity design 8.6 row 8, rows 2 and 6; `ux.md` P1; SEL-14's
 * `identity` part; slice 9b, Ali's ruling 2026-10-09): the Market's sellers whose owner
 * confirmed the email, with the owner's name and address, and its open seller-owner invitations,
 * merged by id and paged like the admin team list. Filter by state (`pending`, `approved`,
 * `rejected`, `suspended`) or `invited`; search by exact email only (11.2: the address of the
 * owner or of the invitation). Rule `permissions [identity.seller-access.view]`.
 *
 * **Personal data only to an entitled admin (Hassan).** A seller actor, the system actor (the
 * gate), an acting-as session and an admin without the key are refused; the actor is re-read in
 * the list's own unit (`readActingGrants` with the view key) **before** any row is read, so a
 * disabled or demoted admin gets `access.denied` and nothing personal is loaded. Only
 * `identity`'s own tables are read: nothing of `sellers` (no store name, no file state). The log
 * line carries counts and codes: never an address, a name or the searched address. No "reset
 * awaiting the owner" field until slice 12 builds the owner-confirmed reset (12.1 row 9b).
 *
 * **Hints (8.6 row 6), no second implementation.** Per row and action, after the action's own
 * key (`access.denied` without it, and nothing else read for it): approve, reject, suspend and
 * reinstate run `sellerAccessVerdict`, the check their command runs before the transition (the
 * domain's `decisionAllowedFrom`; approve's owner guard); re-send runs
 * `sellerInvitationResendVerdict`, the re-send command's guards before its mail counters
 * (`request.throttled` is never hinted); revoke needs only its key, as the list holds pending
 * invitations only. Both invitation commands answer `access.unavailable` while the Market
 * configures no seller-owner invitation lifetime, and so do their hints. Hints only: every
 * command checks again in its own unit.
 *
 * One read-only unit (ADR-0025: no transaction), so the rows and their hints are not one
 * snapshot.
 */
export class ListSellerAccounts extends UseCase<
  ListSellerAccountsInput,
  SellerListPage,
  ListSellerAccountsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: USE_CASE,
    rule: { kind: 'permissions', allOf: [SELLER_ACCESS_VIEW.key] },
  };

  readonly #logger = new Logger('ListSellerAccounts');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListSellerAccountsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListSellerAccountsInput,
  ): Promise<Result<SellerListPage, ListSellerAccountsFailure>> {
    const { market, actor } = context;
    const valid = validated(input);
    const result = valid.ok ? await this.list(context, valid.value) : valid;
    const rows = result.ok ? result.value.items : [];
    this.#logger.log({
      msg: USE_CASE,
      outcome: result.ok ? 'seller-accounts.listed' : result.error.code,
      ...(valid.ok
        ? { filter: valid.value.filter ?? 'all', search: valid.value.emailNormalized !== null }
        : {}),
      ...(result.ok
        ? {
            sellers: rows.filter((row) => row.type === 'seller').length,
            invitations: rows.filter((row) => row.type === 'invitation').length,
            more: result.value.next !== null,
          }
        : {}),
      ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async list(
    context: CallContext,
    input: ValidInput,
  ): Promise<Result<SellerListPage, ListSellerAccountsFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    // Read before the unit, as the invitation commands do: null answers `access.unavailable`.
    const lifetime = this.deps.policy.invitationLifetimeMinutes(market, 'seller-owner');
    const reapplyLimit = this.deps.policy.sellerReapplyLimit(market);
    const { filter, emailNormalized, limit } = input;
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<SellerListPage, ListSellerAccountsFailure>> => {
        const now = this.deps.clock.now();
        // The actor first, in this unit: no row, and so no personal data, is read for an actor
        // who is no longer an active admin holding the view key (as the 8c list).
        const acting = await readActingGrants(
          this.deps,
          market,
          self,
          [],
          [SELLER_ACCESS_VIEW.key],
        );
        if (acting === null) return err({ code: 'access.denied' });
        const keys = acting.actor.effectiveKeys;

        let sellers: SellerAccountRecord[] = [];
        if (filter !== 'invited') {
          // The exact-email search finds the seller the address owns: never by a staff address.
          const found =
            emailNormalized === null
              ? null
              : await this.deps.sellerAccounts.sellersOfAddress(market, emailNormalized);
          sellers = await this.deps.sellerAccounts.ownedSellers(market, {
            state: filter,
            sellerIds: emailNormalized === null ? null : (found?.sellerIds ?? []),
            ownerAccountId: found?.accountId ?? null,
            after: input.after as Id<'Seller'> | null,
            limit: limit + 1,
          });
        }
        const invitations =
          filter === null || filter === 'invited'
            ? await this.deps.sellerAccounts.openOwnerInvitations(market, {
                emailNormalized,
                after: input.after as Id<'Invitation'> | null,
                limit: limit + 1,
              })
            : [];
        // One row more of each than the page tells whether another page exists.
        const merged: PageEntry[] = [
          ...sellers.map((seller) => ({ id: seller.sellerId, seller })),
          ...invitations.map((invitation) => ({ id: invitation.id, invitation })),
        ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const page = merged.slice(0, limit);

        const rows: SellerListRow[] = [];
        for (const entry of page) {
          if ('seller' in entry) {
            const row = sellerRow(entry.seller, keys, reapplyLimit);
            if (row !== null) rows.push(row);
          } else {
            rows.push(await this.invitationRow(context, entry.invitation, keys, now, lifetime));
          }
        }
        const more = merged.length > limit;
        return ok({ items: rows, next: more ? page[page.length - 1]!.id : null });
      },
      { readOnly: true },
    );
  }

  private async invitationRow(
    context: CallContext,
    invitation: OpenSellerOwnerInvitation,
    keys: ReadonlySet<string>,
    now: Temporal.Instant,
    lifetime: number | null,
  ): Promise<SellerListInvitationRow> {
    const mayChange = keys.has(SELLER_ACCOUNT_CREATE.key);
    let resend: ActionHint;
    if (!mayChange) resend = denied('access.denied');
    else if (lifetime === null) resend = denied('access.unavailable');
    else {
      resend = hintOf(
        await sellerInvitationResendVerdict(
          this.deps,
          context.market,
          {
            state: invitation.state,
            createdAt: invitation.createdAt,
            invitedByAccountId: invitation.invitedByAccountId,
            hasAddress: invitation.email !== '',
          },
          now,
          lifetime,
        ),
      );
    }
    return {
      type: 'invitation',
      invitationId: invitation.id,
      sellerId: invitation.sellerId,
      email: invitation.email,
      displayName: invitation.displayName,
      status: invitationStatusAt(invitation, now) === 'expired' ? 'expired' : 'pending',
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      actions: {
        resend,
        revoke: !mayChange
          ? denied('access.denied')
          : lifetime === null
            ? denied('access.unavailable')
            : ALLOWED,
      },
    };
  }
}

type PageEntry =
  | { readonly id: string; readonly seller: SellerAccountRecord }
  | { readonly id: string; readonly invitation: OpenSellerOwnerInvitation };

/** A seller row and its decision hints; null for a seller without an owner (never listed). */
function sellerRow(
  seller: SellerAccountRecord,
  keys: ReadonlySet<string>,
  reapplyLimit: number | null,
): SellerListSellerRow | null {
  const owner = seller.owner;
  if (owner === null) return null;
  const hint = (verb: SellerAccessVerb): ActionHint =>
    keys.has(DECISION_KEY[verb])
      ? hintOf(sellerAccessVerdict(verb, seller.state, owner.emailVerified))
      : denied('access.denied');
  return {
    type: 'seller',
    sellerId: seller.sellerId,
    origin: seller.origin,
    state: seller.state,
    stateChangedAt: seller.stateChangedAt,
    reapplyLimitReached:
      reapplyLimit === null
        ? null
        : SellerAccess.reapplyLimitReached(seller.state, seller.reapplyCount, reapplyLimit),
    owner: { accountId: owner.accountId, email: owner.email, displayName: owner.displayName },
    actions: {
      approve: hint('approve'),
      reject: hint('reject'),
      suspend: hint('suspend'),
      reinstate: hint('reinstate'),
    },
  };
}

function validated(input: ListSellerAccountsInput): Result<ValidInput, ListSellerAccountsFailure> {
  const fields: { path: string; code: string }[] = [];
  const { limit } = input;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SELLER_LIST_PAGE) {
    fields.push({ path: 'limit', code: 'range' });
  }
  let after: string | null = null;
  if (input.after !== undefined && input.after !== null) {
    const parsed = typeof input.after === 'string' ? parseId(input.after) : null;
    if (parsed === null || !parsed.ok) fields.push({ path: 'after', code: 'format' });
    else after = parsed.value;
  }
  let filter: SellerListFilter | null = null;
  if (input.state !== undefined && input.state !== null) {
    if ((SELLER_LIST_FILTERS as readonly unknown[]).includes(input.state)) {
      filter = input.state as SellerListFilter;
    } else fields.push({ path: 'state', code: 'unknown' });
  }
  let emailNormalized: string | null = null;
  if (input.email !== undefined && input.email !== null) {
    const parsed = parseEmailAddress(input.email);
    if (!parsed.ok) fields.push({ path: 'email', code: 'format' });
    else emailNormalized = parsed.value.normalized;
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({ after, limit, filter, emailNormalized });
}
