import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { AccountEmailChangedAudit } from '../../domain/audit';
import type { LinkPurpose } from '../../domain/one-time-link';
import type { EmailChangeStore } from '../ports/account.repository';
import type { LinkTokens } from '../ports/link-secrets';
import {
  SignInFlow,
  type LinkCloser,
  type LinkSignInDependencies,
  type SignInClient,
  type SignInDependencies,
} from '../sign-in/sign-in-flow';
import { EMAIL_CHANGE_PURPOSE } from './admin-request-customer-email-change.use-case';
import type { FieldProblem } from './register-customer.use-case';
import { MAX_PASSWORD_BYTES } from './sign-in-customer.use-case';

export interface ConfirmCustomerEmailChangeInput {
  /** The token from the link's fragment, posted in the JSON body (Hassan R8). Never logged. */
  readonly token: string;
  /** The account's password (Hassan's answer 1). Never logged. */
  readonly password: string;
  readonly client: SignInClient;
}

/** The address is changed; every session ended and none is opened: the customer signs in again. */
export type ConfirmCustomerEmailChangeOutput = { readonly code: 'email-change.confirmed' };

/** Hassan R7: the anonymous route answers only these, besides a malformed body and an outage. */
export type ConfirmCustomerEmailChangeFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'link.rejected' }
  | { readonly code: 'credentials.invalid' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'request.busy'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' };

export interface ConfirmCustomerEmailChangeDependencies
  extends SignInDependencies, LinkSignInDependencies {
  readonly linkTokens: LinkTokens;
  readonly audit: AuditWriter;
  readonly emailChanges: EmailChangeStore;
}

/** The account's other links that stop working when its address changes (Hassan's answer 2). */
const OTHER_LINKS: readonly LinkPurpose[] = ['verify-email', 'reset-password'];

/**
 * `identity.confirm-customer-email-change`: the customer confirms, with the link mailed to the new
 * address and the account's password, the sign-in email an admin asked for (customers admin email
 * change; Mohammad 1 to 4, Hassan R1, R2, R6, R7, R10, R11). Rule `anonymous`: the link and the
 * password are the credential. Modelled on `ConfirmSellerSecondFactorReset`, but through the
 * sign-in sequence ({@link SignInFlow.runLinkClose}) with the purpose `confirm-email-change`, so it
 * has sign-in's throttling, counters and records: a wrong password counts on the per-account
 * failure counter (Mohammad 2) and is `credentials.invalid`. A token of any other purpose (and a
 * `confirm-email-change` token on any other route) answers `link.rejected`.
 *
 * The closing step, in sign-in's closing unit after the credential lock and the account read again
 * (R6): an active, verified customer account whose pending request is the one the link was
 * requested with (R2), the new address not held by another customer account of the Market; the
 * link consumed by its conditional statement at the version read; the address swapped, verified
 * now (`identity.account-email-changed.v1`, Mohammad 4); the notice of this change kept sealed
 * (R11, Hassan M1); **every session revoked** (`email-changed`) and **none opened**; the account's
 * other live links (verify-email, reset-password) cancelled; the audit row
 * `identity.account.email-changed` (R10). A clash on the unique email key at the save rolls the
 * whole unit back and answers `link.rejected`. Every cause of a refused link is `link.rejected`.
 *
 * The token is never logged, stored or echoed; only its SHA-256 is compared (R8).
 */
export class ConfirmCustomerEmailChange extends UseCase<
  ConfirmCustomerEmailChangeInput,
  ConfirmCustomerEmailChangeOutput,
  ConfirmCustomerEmailChangeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.confirm-customer-email-change',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('ConfirmCustomerEmailChange');
  readonly #flow: SignInFlow;

  constructor(
    gate: UseCaseGate,
    private readonly deps: ConfirmCustomerEmailChangeDependencies,
  ) {
    super(gate);
    this.#flow = new SignInFlow('customer', deps, deps);
  }

  protected async handle(
    context: CallContext,
    input: ConfirmCustomerEmailChangeInput,
  ): Promise<Result<ConfirmCustomerEmailChangeOutput, ConfirmCustomerEmailChangeFailure>> {
    const result = await this.#handle(context, input);
    this.#logger.log({
      msg: 'identity.confirm-customer-email-change',
      outcome: result.ok ? result.value.code : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #handle(
    context: CallContext,
    input: ConfirmCustomerEmailChangeInput,
  ): Promise<Result<ConfirmCustomerEmailChangeOutput, ConfirmCustomerEmailChangeFailure>> {
    if (typeof input.password !== 'string' || typeof input.token !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'token', code: 'type' }] });
    }
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const outcome = await this.#flow.runLinkClose(
      context,
      this.deps.linkTokens.hashOf(input.token),
      EMAIL_CHANGE_PURPOSE,
      input.password,
      input.client,
      this.#close,
    );
    if (outcome.ok) return ok({ code: 'email-change.confirmed' });
    const refusal = outcome.error;
    switch (refusal.code) {
      case 'credentials.invalid':
      case 'link.rejected':
      case 'access.unavailable':
        return err({ code: refusal.code });
      case 'request.throttled':
      case 'request.busy':
        return err({ code: refusal.code, retryAfterSeconds: refusal.retryAfterSeconds });
      default:
        // R7: nothing else of the account's state is told to an anonymous caller.
        return err({ code: 'link.rejected' });
    }
  }

  readonly #close: LinkCloser<{ readonly revokedSessions: number }> = async ({
    context,
    account,
    link,
    now,
  }) => {
    const { market } = context;
    const { deps } = this;
    if (account.state.population !== 'customer') return err('rejected');
    const accountId = account.state.id;
    // R2: bound to the pending request the link was requested with; refuses when cancelled,
    // replaced or already confirmed. Nothing is written before every check passed.
    // Sajad 5: the pending address lapses at its request plus the link lifetime, even when a late
    // mail issued the link later; no lifetime configured is fail-closed.
    const lifetimeMinutes = deps.policy.linkLifetimeMinutes(market, EMAIL_CHANGE_PURPOSE);
    if (lifetimeMinutes === null) return err('rejected');
    const confirmed = account.confirmEmailChange({
      requestedAt: link.state.requestedAt,
      now,
      lifetimeMinutes,
    });
    if (!confirmed.ok) return err('rejected');
    const holder = await deps.accounts.findByEmail(
      market,
      'customer',
      account.state.email.normalized,
    );
    if (holder !== null && holder.state.id !== accountId) return err('rejected');
    // Bound to the link read with the token: a link requested again (or used) since is refused.
    if (!(await deps.links.consume(market, link.state.id, link.state.version, now))) {
      return err('rejected');
    }
    // The unique key decides a concurrent holder: `AccountEmailTakenError` rolls everything back.
    await deps.accounts.save(market, account);
    // Hassan M1: one notice per change, keyed by the version this change produced (the event's
    // aggregate version), with both addresses of this change; a later change keeps its own.
    await deps.emailChanges.recordNotice(
      market,
      accountId,
      account.state.version,
      { previousEmail: confirmed.value.typed, newEmail: account.state.email.typed },
      now,
    );
    const revokedSessions = await deps.sessions.revokeAllOf(
      market,
      accountId,
      'email-changed',
      now,
      null,
    );
    for (const purpose of OTHER_LINKS) await deps.links.cancelUnused(market, accountId, purpose);
    await deps.outbox.append(context, account.pendingEvents);
    await deps.audit.record(
      context,
      AccountEmailChangedAudit.entry(accountId, {
        after: { boundSubjectId: accountId, revokedSessions },
      }),
    );
    return ok({ outcome: 'email-changed', value: { revokedSessions } });
  };
}
