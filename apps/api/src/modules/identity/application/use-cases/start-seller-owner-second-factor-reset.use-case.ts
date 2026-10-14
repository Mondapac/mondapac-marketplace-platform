import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLER_ACCOUNT_RESET_SECOND_FACTOR } from '../../contracts/permissions';
import { SellerSecondFactorResetRequestedAudit } from '../../domain/audit';
import { OneTimeLink } from '../../domain/one-time-link';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { LinkTargets } from '../ports/link-secrets';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleRepository } from '../ports/throttle.repository';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { reserveInvitationMail } from '../sellers/invitation-mail-budget';
import { readSellerPeople } from '../sellers/seller-owner';

const RULE_KEYS = [SELLER_ACCOUNT_RESET_SECOND_FACTOR.key];

export interface StartSellerOwnerSecondFactorResetInput {
  readonly sellerId: Id<'Seller'>;
  /** The IPv4 address or the IPv6 /64 of the admin's client (ADR-0037): the `mail.origin` key. */
  readonly origin: string;
}

export interface StartSellerOwnerSecondFactorResetOutput {
  readonly code: 'second-factor-reset.requested';
  readonly sellerId: Id<'Seller'>;
}

export type StartSellerOwnerSecondFactorResetFailure =
  /** No registered seller with this id in the Market: "not found" (5.2). */
  | { readonly code: 'seller.unknown' }
  /** The seller has no active owner account (an invitation not yet accepted, or disabled). */
  | { readonly code: 'account.unknown' }
  /** The owner has no active factor: nothing to reset. */
  | { readonly code: 'second-factor.none' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  /** The Market configures no lifetime or page for the confirmation link: fail closed. */
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface StartSellerOwnerSecondFactorResetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sellerAccess: SellerAccessRepository;
  readonly memberships: SellerMembershipRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly factors: SecondFactorRepository;
  readonly links: OneTimeLinkRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly targets: LinkTargets;
  readonly policy: IdentityMarketPolicy;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * An admin starts the reset of a Seller Owner's second factor (identity design 3.7, 7.3, 5.5;
 * `ux.md` F7 step 4, E15; slice 12). Rule `permissions
 * [identity.seller-account.reset-second-factor]` (platform scope). Across scopes the permission
 * alone decides (`GrantPolicy.canActOn`, 5.5: the key sets of the two scopes share nothing, and
 * the actor is an admin, the target a seller-side account, so "never one's own" cannot arise).
 * **Nothing is removed**: the owner's `confirm-second-factor-reset` link is requested, the
 * mail handler mails E15 and stores the hash, and `ConfirmSellerSecondFactorReset` removes the
 * factor when the owner uses the link.
 *
 * One read-write unit: the actor, still an active, verified admin holding the key, read in this
 * unit (C1, else `access.denied`); the seller, registered in this Market (`seller.unknown`); its
 * owner, an active account (`account.unknown`) with an active factor (`second-factor.none`); the
 * mail counters of the owner's address and the admin's client (6.8, as the seller invitation;
 * a refusal commits nothing); the link requested again, so an earlier link stops working (3.7);
 * `identity.one-time-link-requested.v1` and the audit row `identity.seller-second-factor-
 * reset.requested` as the admin. A Market without the link's lifetime or page answers
 * `access.unavailable` before anything is written, so no reset is left waiting for a mail that
 * cannot be sent.
 */
export class StartSellerOwnerSecondFactorReset extends UseCase<
  StartSellerOwnerSecondFactorResetInput,
  StartSellerOwnerSecondFactorResetOutput,
  StartSellerOwnerSecondFactorResetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.start-seller-owner-second-factor-reset',
    rule: { kind: 'permissions', allOf: [SELLER_ACCOUNT_RESET_SECOND_FACTOR.key] },
  };

  readonly #logger = new Logger('StartSellerOwnerSecondFactorReset');

  constructor(
    gate: UseCaseGate,
    private readonly deps: StartSellerOwnerSecondFactorResetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: StartSellerOwnerSecondFactorResetInput,
  ): Promise<
    Result<StartSellerOwnerSecondFactorResetOutput, StartSellerOwnerSecondFactorResetFailure>
  > {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const { deps } = this;
    if (
      deps.policy.linkLifetimeMinutes(market, 'confirm-second-factor-reset') === null ||
      deps.targets.target(market, 'seller', 'confirm-second-factor-reset') === null
    ) {
      this.log(context, input, 'access.unavailable');
      return err({ code: 'access.unavailable' });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    const result = await deps.unitOfWork.run(
      market,
      async (): Promise<
        Result<StartSellerOwnerSecondFactorResetOutput, StartSellerOwnerSecondFactorResetFailure>
      > => {
        const now = deps.clock.now();
        // C1: the actor is still an active admin holding the rule's key, read in this unit.
        const reading = await readActingGrants(deps, market, self, [], RULE_KEYS);
        if (reading === null) return err({ code: 'access.denied' });
        const access = await deps.sellerAccess.findById(market, input.sellerId);
        if (access === null || !access.isRegistered) return err({ code: 'seller.unknown' });
        const { owner } = await readSellerPeople(deps, market, input.sellerId);
        if (owner === null || owner.state.status !== 'active') {
          return err({ code: 'account.unknown' });
        }
        const ownerId = owner.state.id;
        const factor = await deps.factors.findByAccount(market, ownerId);
        if (factor === null || factor.state.state !== 'active') {
          return err({ code: 'second-factor.none' });
        }
        const verdict = await reserveInvitationMail(
          deps,
          market,
          owner.state.email.normalized,
          input.origin,
          now,
        );
        if (!verdict.allowed) {
          return err({ code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds });
        }
        const found = await deps.links.findFor(market, ownerId, 'confirm-second-factor-reset');
        let link: OneTimeLink;
        if (found === null) {
          link = OneTimeLink.request({
            id: deps.ids.next<'OneTimeLink'>(),
            marketId: market.marketId,
            accountId: ownerId,
            purpose: 'confirm-second-factor-reset',
            now,
            notify: true,
          });
          await deps.links.add(market, link);
        } else {
          link = found;
          link.requestAgain(now, true);
          await deps.links.save(market, link);
        }
        await deps.outbox.append(context, link.pendingEvents);
        await deps.audit.record(
          context,
          SellerSecondFactorResetRequestedAudit.entry(ownerId, {
            after: { sellerId: input.sellerId },
          }),
        );
        return ok({ code: 'second-factor-reset.requested', sellerId: input.sellerId });
      },
    );
    this.log(context, input, result.ok ? result.value.code : result.error.code);
    return result;
  }

  /** Ids and codes only: never the address or a token (P 12.3). */
  private log(
    context: CallContext,
    input: StartSellerOwnerSecondFactorResetInput,
    outcome: string,
  ): void {
    this.#logger.log({
      msg: 'identity.start-seller-owner-second-factor-reset',
      outcome,
      sellerId: input.sellerId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
