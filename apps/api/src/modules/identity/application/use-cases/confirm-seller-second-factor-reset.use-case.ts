import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SellerSecondFactorResetConfirmedAudit } from '../../domain/audit';
import { reservationVerdict } from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { LinkTokens } from '../ports/link-secrets';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import { isSellerOwner } from '../sellers/seller-owner';
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';

export interface ConfirmSellerSecondFactorResetInput {
  /** The token from the link's fragment, posted in the JSON body (identity design 6.6, I15). */
  readonly token: string;
  readonly client: SignInClient;
}

/** The factor is gone; the owner signs in with the password alone (`ux.md` A11 "done"). */
export type ConfirmSellerSecondFactorResetOutput = {
  readonly code: 'second-factor.reset';
};

export type ConfirmSellerSecondFactorResetFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  /** One answer for every cause (8.6 row 1): `ux.md` F7 step 4. */
  | { readonly code: 'link.rejected' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' };

export interface ConfirmSellerSecondFactorResetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly links: OneTimeLinkRepository;
  readonly linkTokens: LinkTokens;
  readonly memberships: SellerMembershipRepository;
  readonly grants: RoleGrantReader;
  readonly factors: SecondFactorRepository;
  readonly sessions: SessionRepository;
  readonly challenges: SignInChallengeRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly policy: IdentityMarketPolicy;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

const REJECTED = Object.freeze({ code: 'link.rejected' as const });
const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

type Closed =
  | { readonly kind: 'reset'; readonly revokedSessions: number }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'throttled'; readonly retryAfterSeconds: number };

/**
 * The Seller Owner confirms, with the link of E15, a second-factor reset that an admin started
 * (identity design 3.6 `active` → `none`, 3.7, 7.3; `ux.md` A11, F7 step 4; slice 12). Rule
 * `anonymous`: the link's token is the credential, and its account is the owner it was mailed to.
 * One read-write unit:
 *
 * 1. `sign-in.origin` is counted (the reservation of reset and link sign-in, 6.3); a counter at
 *    its limit answers `request.throttled`, an unreachable table `access.unavailable` (fail
 *    closed, 6.8).
 * 2. The link is read by the hash of its token. A token that is malformed, unknown, used,
 *    expired, replaced by a newer request or of another purpose answers `link.rejected` and
 *    stays counted, as does one whose account is no longer an active, verified seller-side
 *    account that holds the Seller Owner's role in an active membership (a demoted or removed
 *    member never confirms), or has no factor left to reset.
 * 3. The credential lock first (HF11), the account read again, then the link consumed by its
 *    conditional statement at the version read (single use under concurrency, L1); the factor's
 *    last version step, its removal with its recovery codes, **every session revoked**
 *    (`second-factor-reset`), **every open challenge void**, `second-factor-changed` (`reset`,
 *    which mails E14) and the audit row `identity.seller-second-factor-reset.confirmed`; the origin
 *    reservation given back. No session is opened: the owner signs in with the password alone
 *    (F7 step 5). `second-factor.account` is never touched (6.8).
 *
 * The token is never logged, stored or echoed.
 */
export class ConfirmSellerSecondFactorReset extends UseCase<
  ConfirmSellerSecondFactorResetInput,
  ConfirmSellerSecondFactorResetOutput,
  ConfirmSellerSecondFactorResetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.confirm-seller-second-factor-reset',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('ConfirmSellerSecondFactorReset');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ConfirmSellerSecondFactorResetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ConfirmSellerSecondFactorResetInput,
  ): Promise<Result<ConfirmSellerSecondFactorResetOutput, ConfirmSellerSecondFactorResetFailure>> {
    const { market } = context;
    const { deps } = this;
    const tokenHash = deps.linkTokens.hashOf(input.token);
    const counter: ThrottleCounter = {
      kind: 'sign-in.origin',
      keyHash: deps.keys.origin(market, input.client.origin),
      accountKey: null,
      rule: deps.policy.signInThrottles(market).origin,
    };
    let closed: Closed;
    try {
      const run = await deps.unitOfWork.run(market, async (): Promise<Result<Closed, never>> => {
        const now = deps.clock.now();
        const reservations = await deps.throttles.reserve(market, [counter], now);
        const verdict = reservationVerdict(
          reservations.map((reservation) => ({ reservation, rule: counter.rule })),
          now,
        );
        if (!verdict.allowed) {
          return ok({ kind: 'throttled', retryAfterSeconds: verdict.retryAfterSeconds });
        }
        const link =
          tokenHash === null ? null : await deps.links.findByTokenHash(market, tokenHash);
        if (link === null || !link.usableFor('confirm-second-factor-reset', now)) {
          return ok({ kind: 'rejected' });
        }
        const accountId = link.state.accountId;
        // HF11: the credential lock first, then the account read again.
        if (!(await deps.accounts.lockCredential(market, accountId))) {
          return ok({ kind: 'rejected' });
        }
        const account = await deps.accounts.findById(market, accountId);
        if (
          account === null ||
          account.state.population !== 'seller' ||
          account.state.status !== 'active' ||
          !account.isEmailVerified
        ) {
          return ok({ kind: 'rejected' });
        }
        // Still the Seller Owner of a seller: the link proves the mailbox, not the role.
        const membership = await deps.memberships.findActiveByAccount(market, accountId);
        if (membership === null || !(await isSellerOwner(deps, market, accountId))) {
          return ok({ kind: 'rejected' });
        }
        const factor = await deps.factors.findByAccount(market, accountId);
        if (factor === null) return ok({ kind: 'rejected' });
        // Bound to the link read with the token: a link requested again (or used) since has
        // another version, and this use is refused (L1).
        if (!(await deps.links.consume(market, link.state.id, link.state.version, now))) {
          return ok({ kind: 'rejected' });
        }
        const before = factor.state.state;
        factor.recordReset(now);
        await deps.factors.removeOf(market, accountId);
        const revokedSessions = await deps.sessions.revokeAllOf(
          market,
          accountId,
          'second-factor-reset',
          now,
          null,
        );
        await deps.challenges.voidAllOf(market, accountId);
        await deps.throttles.release(market, reservations);
        await deps.outbox.append(context, factor.pendingEvents);
        await deps.audit.record(
          context,
          SellerSecondFactorResetConfirmedAudit.entry(factor.state.id, {
            before: { state: before },
            after: { boundSubjectId: accountId },
          }),
        );
        return ok({ kind: 'reset', revokedSessions });
      });
      if (!run.ok) return err(UNAVAILABLE);
      closed = run.value;
    } catch {
      // The counter table or the unit is unreachable: fail closed (6.8). Nothing was kept.
      this.#logger.log({
        msg: 'identity.confirm-seller-second-factor-reset.unavailable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err(UNAVAILABLE);
    }
    this.#logger.log({
      msg: 'identity.confirm-seller-second-factor-reset',
      outcome:
        closed.kind === 'reset'
          ? 'second-factor.reset'
          : closed.kind === 'rejected'
            ? 'link.rejected'
            : 'request.throttled',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    if (closed.kind === 'throttled') {
      return err({ code: 'request.throttled', retryAfterSeconds: closed.retryAfterSeconds });
    }
    if (closed.kind === 'rejected') return err(REJECTED);
    return ok({ code: 'second-factor.reset' });
  }
}
