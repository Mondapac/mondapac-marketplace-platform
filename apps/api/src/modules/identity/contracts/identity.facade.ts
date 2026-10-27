import type { CallContext, Id, Population, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { StepUpFailure } from './step-up';

/**
 * Who the calling actor is (identity design 8.1 `describeActor`): ids and codes only, never a
 * name or an email. The role and the seller's access state are read from slice 5, the effective
 * permission keys from slice 8a-1 (sorted); `secondFactorActive` says whether the account's second
 * factor is active (slice 7b).
 */
export interface ActorDescription {
  readonly accountId: Id<'Account'>;
  readonly population: Population;
  readonly sellerId: Id<'Seller'> | null;
  readonly roleId: string | null;
  readonly permissionKeys: readonly string[];
  readonly sellerAccessState: string | null;
  readonly secondFactorActive: boolean;
}

/** Why {@link IdentityFacade.confirmSecondFactor} refused. Codes and field paths only. */
export type ConfirmSecondFactorFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'second-factor.invalid' }
  | { readonly code: 'second-factor.locked'; readonly retryAfterSeconds: number }
  /** The account has no active second factor. */
  | { readonly code: 'second-factor.unavailable' }
  | { readonly code: 'session.invalid' }
  | { readonly code: 'access.unavailable' };

/** The seller an account works for, and its role (8.1 `membershipOf`); null when none. */
export type SellerMembershipSummary = {
  readonly sellerId: Id<'Seller'>;
  readonly roleId: Id<'Role'> | null;
} | null;

/** Whose address {@link IdentityFacade.contactEmailOf} reads. */
export type ContactEmailTarget =
  | { readonly kind: 'customer'; readonly accountId: Id<'Account'> }
  | { readonly kind: 'seller-owner'; readonly sellerId: Id<'Seller'> };

/**
 * One customer of {@link IdentityFacade.customerAccountSummaries}. The name and the address are
 * PERSONAL DATA for the admin who asked: no module logs them or puts them in an event, an audit
 * row, a cache, an outbox or an error body, and they are rendered as escaped text only.
 */
export interface CustomerAccountSummary {
  readonly accountId: Id<'Account'>;
  /** Null when the customer gave none (customers sign up without a name). */
  readonly displayName: string | null;
  /** The sign-in address, as typed. */
  readonly email: string;
}

/**
 * One customer of {@link IdentityFacade.customerShortNames}: the short name only ("Maryam R.").
 * PERSONAL DATA for the seller who asked: no module logs it or puts it in an event, an audit row,
 * a cache, an outbox, a stored notice or an error body, and it is rendered as escaped text only.
 */
export interface CustomerShortName {
  readonly accountId: Id<'Account'>;
  readonly shortName: string;
}

/**
 * One current member of the actor's own team (`teamMemberLabels`): the display name and the role,
 * never the sign-in address. PERSONAL DATA for the member who asked: no module logs it or puts it
 * in an event, an audit row, a cache, an outbox or an error body; rendered as escaped text only.
 */
export interface TeamMemberLabel {
  readonly accountId: Id<'Account'>;
  readonly displayName: string | null;
  /**
   * `seedCode` labels a system or default role (a translation key); `name` a custom one. Null for
   * a member without a role this seller can see.
   */
  readonly role: {
    readonly kind: 'system' | 'default' | 'custom';
    readonly seedCode: string | null;
    readonly name: string | null;
  } | null;
}

/** A request the facade refused before any read: a code and the field, never its value. */
export interface IdentityValidationFailed {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

/**
 * The public facade of `identity` (identity design 8.1). Every method takes the caller's
 * `CallContext` first, unchanged, and is a thin call of one use case, so the gate runs (PF 6.4
 * row 2). Other modules inject {@link IDENTITY_FACADE}; they never read identity's tables.
 */
export interface IdentityFacade {
  /** Rule `own-resources`, allowed when the seller is not approved. */
  describeActor(context: CallContext): Promise<Result<ActorDescription, AccessDenied>>;

  /**
   * The active membership of `accountId` and its role, or null. For the actor's own account
   * (slice 5): rule `own-resources`, allowed when the seller is not approved. For another account
   * (slice 8a-1): rule `identity.team-member.view`, seller scope, denied while the seller is not
   * approved; an account outside the actor's own team answers null, as one without a membership.
   */
  membershipOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<SellerMembershipSummary, AccessDenied>>;

  /**
   * A recent confirmation of the signed-in seller-side holder: `code` is a current code from the
   * authenticator app or a recovery code. It is counted on the sign-in code throttle and spent
   * once, and nothing else changes. Rule `own-resources`, denied while the seller is not
   * approved. Refusals: `second-factor.invalid`, `second-factor.locked` (with the wait) and
   * `second-factor.unavailable` (no active factor). The code is never logged or stored.
   */
  confirmSecondFactor(
    context: CallContext,
    code: string,
  ): Promise<Result<void, ConfirmSecondFactorFailure>>;

  /**
   * Whether the sensitive seller action `actionKey` (a registered step-up action) may go ahead
   * now (seller OTP policy). Call it first in the use case that does the action, with the
   * caller's `CallContext` unchanged, and pass its refusal on: `second-factor.required`
   * (`actionKey` in the details) tells the panel to verify a code for that action and repeat the
   * request; `second-factor.enrolment-required` that the member must set up two-step first. For
   * a seller action, a caller that is not a seller session passes. For an admin action
   * (`audience: 'admin'`, issue #491) an admin session always needs a fresh proof of its own
   * (`POST identity/admin/step-up/verify`) and any other caller is refused `access.denied`; an
   * acting-as session is refused for every action. An unregistered key answers
   * `access.unavailable`. Rule `own-resources`, allowed while the seller is not approved (the guarded
   * action refuses it itself).
   */
  requireStepUp(context: CallContext, actionKey: string): Promise<Result<void, StepUpFailure>>;

  /**
   * The address to mail a notice to, for the `system` caller only (the order emails): a customer
   * account's own, or a seller Owner's. `null` when there is none to use: unknown, of another
   * Market or population, disabled or not verified, all alike. Personal data: the caller uses it
   * for one send and never logs, stores or puts it in an event.
   */
  contactEmailOf(
    context: CallContext,
    target: ContactEmailTarget,
  ): Promise<Result<string | null, AccessDenied>>;

  /**
   * The display name and sign-in address of each requested customer account, for an admin page
   * that shows who placed an order. Rule `permissions [identity.customer-account.view]`, checked
   * by the gate and again in the read; the system actor, a seller, a customer and an acting-as
   * session are refused. At most 100 ids, duplicates answered once; an unknown id, another
   * Market's and a non-customer account are absent. Not exposed over HTTP.
   */
  customerAccountSummaries(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<Result<readonly CustomerAccountSummary[], AccessDenied | IdentityValidationFailed>>;

  /**
   * The short name ("Maryam R.") of each requested customer account, for the seller's own order
   * notices. Rule `permissions [identity.customer-short-name.view]`, seller scope, denied while
   * the seller is not approved; checked by the gate and again in the read. The system actor, an
   * admin, a customer and an acting-as session are refused. The caller passes only customers of
   * the shop's own paid seller orders (`ordering` checks that). At most 100 ids; an unknown id,
   * another Market's, a non-customer and a nameless account are absent. Not exposed over HTTP.
   */
  customerShortNames(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<Result<readonly CustomerShortName[], AccessDenied | IdentityValidationFailed>>;

  /**
   * The name and role of each requested account that is a current member of the actor's own
   * team, for a seller page that shows who changed something (sellers' minimum-order history).
   * Rule `own-resources`, seller scope, denied while the seller is not approved; the actor is read
   * again in the read. At most 100 ids, duplicates answered once; a removed member, another
   * seller's member, another population's, another Market's and an unknown account are all
   * absent. Not exposed over HTTP.
   */
  teamMemberLabels(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<Result<readonly TeamMemberLabel[], AccessDenied | IdentityValidationFailed>>;
}

/** Nest token of the {@link IdentityFacade}, provided and exported by `IdentityModule`. */
export const IDENTITY_FACADE = Symbol('IDENTITY_FACADE');
