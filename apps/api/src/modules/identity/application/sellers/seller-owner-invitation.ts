import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  MarketContext,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLER_ACCOUNT_CREATE } from '../../contracts/permissions';
import { InvitationReissuedAudit, InvitationRevokedAudit } from '../../domain/audit';
import { invitationReissuableAt, type InvitationState } from '../../domain/invitation';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleRepository } from '../ports/throttle.repository';
import { readActingGrants, type ActingGrantDependencies } from '../roles/granting';
import { reserveInvitationMail } from './invitation-mail-budget';

const RULE_KEYS = [SELLER_ACCOUNT_CREATE.key];

export interface SellerOwnerInvitationInput {
  readonly invitationId: Id<'Invitation'>;
  /** The admin's client: the `mail.origin` key of a re-send (6.8; Hassan M1). */
  readonly origin: string;
}

export interface SellerOwnerInvitationChanged {
  readonly code: 'invitation.reissued' | 'invitation.revoked';
  readonly invitationId: Id<'Invitation'>;
}

export type SellerOwnerInvitationFailure =
  /** No seller-owner invitation with this id in the Market: "not found". */
  | { readonly code: 'invitation.unknown' }
  /** Decided, past its lifetime (re-send), or its inviter could no longer issue it (re-send). */
  | { readonly code: 'invitation.rejected' }
  /** Re-send: `mail.account` of the invited address or `mail.origin` is used up (6.8). */
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface SellerOwnerInvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly invitations: InvitationRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

const logger = new Logger('SellerOwnerInvitation');

/**
 * Whether the inviter of a seller-owner invitation could still issue it (identity design 3.4:
 * "the inviter is still active and could still grant the role"; Hassan 14.2): an active, verified
 * admin of this Market holding `identity.seller-account.create`, read in the caller's unit. The
 * seller system role is granted by the creation of the scope, not under R1 (5.5), so the key is
 * the whole check.
 */
export async function sellerInviterStillStands(
  deps: ActingGrantDependencies,
  market: MarketContext,
  inviterId: Id<'Account'> | null,
): Promise<boolean> {
  if (inviterId === null) return false;
  const reading = await readActingGrants(
    deps,
    market,
    { accountId: inviterId, population: 'admin', sellerId: null },
    [],
    RULE_KEYS,
  );
  return reading !== null;
}

/**
 * The guards of re-sending a found, pending seller-owner invitation, before its mail counters
 * (identity design 3.4; slices 9 and 9b): within its lifetime (Mohammad C2), its inviter still
 * standing (Hassan L3) and an address still on it, else `invitation.rejected`. The re-send
 * command runs it after its key; the admin seller list's re-send hint runs it after the same key.
 * It reads only the fields named, so a summary without the token hash serves as well as the
 * aggregate's state.
 */
export async function sellerInvitationResendVerdict(
  deps: ActingGrantDependencies,
  market: MarketContext,
  invitation: Pick<InvitationState, 'state' | 'createdAt' | 'invitedByAccountId'> & {
    readonly hasAddress: boolean;
  },
  now: Temporal.Instant,
  lifetimeMinutes: number,
): Promise<Result<void, { readonly code: 'invitation.rejected' }>> {
  if (!invitationReissuableAt(invitation, now, lifetimeMinutes)) {
    return err({ code: 'invitation.rejected' });
  }
  if (!(await sellerInviterStillStands(deps, market, invitation.invitedByAccountId))) {
    return err({ code: 'invitation.rejected' });
  }
  return invitation.hasAddress ? ok(undefined) : err({ code: 'invitation.rejected' });
}

/**
 * Re-send and revoke of a seller-owner invitation (identity design 3.4 `pending` → `pending`,
 * `pending` → `revoked`; `ux.md` F9 step 6 "Resend" and "Cancel"; slice 9), the routine of
 * `identity.resend-seller-invitation` and `identity.revoke-seller-invitation`, both under
 * `identity.seller-account.create`. One unit at READ COMMITTED: the actor re-checked
 * (`readActingGrants`), then a seller-owner invitation of this Market (else
 * `invitation.unknown`). A re-send needs the invitation within its lifetime (Mohammad C2) and its
 * inviter still standing (Hassan L3), else `invitation.rejected`; the old token stops working at
 * once and the mail handler sends a new one. A revoke leaves the seller without an owner: it can
 * be invited again (HF5 (a)). A re-send counts the mail on `mail.account` of the invited address
 * and `mail.origin` (6.8; Hassan M1), after the checks above: used up is `request.throttled`,
 * and nothing commits. Audit `identity.invitation.reissued` or `.revoked`.
 */
export async function changeSellerOwnerInvitation(
  deps: SellerOwnerInvitationDependencies,
  context: CallContext,
  input: SellerOwnerInvitationInput,
  change: 'resend' | 'revoke',
): Promise<Result<SellerOwnerInvitationChanged, SellerOwnerInvitationFailure>> {
  const { market, actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const lifetime = deps.policy.invitationLifetimeMinutes(market, 'seller-owner');
  if (lifetime === null) return err({ code: 'access.unavailable' });
  const self = { accountId: actor.accountId, population: 'admin' as const, sellerId: null };
  const result = await deps.unitOfWork.run(
    market,
    async (): Promise<Result<SellerOwnerInvitationChanged, SellerOwnerInvitationFailure>> => {
      const now = deps.clock.now();
      const reading = await readActingGrants(deps, market, self, [], RULE_KEYS);
      if (reading === null) return err({ code: 'access.denied' });
      const invitation = await deps.invitations.findById(market, input.invitationId);
      if (invitation === null || invitation.state.kind !== 'seller-owner') {
        return err({ code: 'invitation.unknown' });
      }
      const { kind, roleId } = invitation.state;
      if (change === 'resend') {
        const address = invitation.state.email;
        const guards = await sellerInvitationResendVerdict(
          deps,
          market,
          { ...invitation.state, hasAddress: address !== null },
          now,
          lifetime,
        );
        if (!guards.ok || address === null) return err({ code: 'invitation.rejected' });
        const verdict = await reserveInvitationMail(
          deps,
          market,
          address.normalized,
          input.origin,
          now,
        );
        if (!verdict.allowed) {
          return err({ code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds });
        }
        if (!invitation.reissue(now, lifetime).ok) return err({ code: 'invitation.rejected' });
      } else if (!invitation.revoke(now).ok) {
        return err({ code: 'invitation.rejected' });
      }
      await deps.invitations.save(market, invitation);
      await deps.outbox.append(context, invitation.pendingEvents);
      const audited = change === 'resend' ? InvitationReissuedAudit : InvitationRevokedAudit;
      await deps.audit.record(
        context,
        audited.entry(invitation.state.id, { after: { kind, roleId } }),
      );
      return ok({
        code: change === 'resend' ? 'invitation.reissued' : 'invitation.revoked',
        invitationId: invitation.state.id,
      });
    },
  );
  logger.log({
    msg: `identity.${change}-seller-invitation`,
    outcome: result.ok ? result.value.code : result.error.code,
    invitationId: input.invitationId,
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return result;
}
