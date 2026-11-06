import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { AGENTS_MANAGE_KEY } from '../../contracts/agent-access';
import { AgentInvitationIssuedAudit, AgentInvitationRevokedAudit } from '../../domain/audit';
import type { EmailAddress } from '../../domain/email-address';
import { normaliseHandoverCode } from '../../domain/handover-code';
import { Invitation } from '../../domain/invitation';
import { reservationVerdict } from '../../domain/throttle';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { HandoverCodes } from '../ports/handover-codes';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import { readActingGrants } from '../roles/granting';

export interface AgentInvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly invitations: InvitationRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly codes: HandoverCodes;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The acting admin, re-checked in the unit that writes (as `InviteAdmin`, Mohammad C1): an active,
 * verified admin account of this Market whose effective keys hold `agents.manage`. The key is the
 * `agents` module's rule, passed through the caller's own actor (ADR-0045; design 3). False: the
 * caller answers `access.denied`.
 */
export async function actingAgentManager(
  deps: Pick<AgentInvitationDependencies, 'accounts' | 'grants' | 'effectiveKeys'>,
  context: CallContext,
): Promise<boolean> {
  const { actor, market } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return false;
  const reading = await readActingGrants(
    deps,
    market,
    { accountId: actor.accountId, population: 'admin', sellerId: null },
    [],
    [AGENTS_MANAGE_KEY],
  );
  return reading !== null;
}

export interface IssuedAgentInvitation {
  readonly accountId: Id<'Account'>;
  readonly invitationId: Id<'Invitation'>;
  /** Shown once, to the issuing admin; only its HMAC is stored. */
  readonly handoverCode: string;
}

export type IssueRefusal =
  | { readonly code: 'invitation.already-pending' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number };

/**
 * Issues an agent invitation inside the caller's open unit (identity design 3.4 `(none)` to
 * `pending`; ADR-0045 decision 2). `agentAccountId` is reserved here and returned to the admin; a
 * re-issue keeps it. The address already having an agent account, or a pending invitation that is
 * not yet stale, is `invitation.already-pending` (to the admin only). A stale pending one (past
 * its expiry, or never dispatched and older than the lifetime) is revoked first and audited. The
 * `mail.account` counter of the address (agent population) is counted before the rows are written;
 * a refusal commits nothing.
 */
export async function issueAgentInvitation(
  deps: AgentInvitationDependencies,
  context: CallContext,
  params: {
    readonly email: EmailAddress;
    readonly displayName: string;
    readonly lifetimeMinutes: number;
    readonly agentAccountId?: Id<'Account'>;
  },
): Promise<Result<IssuedAgentInvitation, IssueRefusal>> {
  const { market, actor } = context;
  if (actor.kind !== 'authenticated') throw new Error('issueAgentInvitation: no admin actor');
  const now = deps.clock.now();
  const normalized = params.email.normalized;
  if ((await deps.accounts.findByEmail(market, 'agent', normalized)) !== null) {
    return err({ code: 'invitation.already-pending' });
  }
  const budget = await reserveAgentInvitationMail(deps, market, normalized, now);
  if (!budget.allowed) {
    return err({ code: 'request.throttled', retryAfterSeconds: budget.retryAfterSeconds });
  }
  const pending = await deps.invitations.findPendingAgentFor(market, normalized);
  if (pending !== null) {
    if (!pending.replaceableAt(now, params.lifetimeMinutes)) {
      return err({ code: 'invitation.already-pending' });
    }
    await revokeAgentInvitation(deps, context, pending);
  }
  const invitationId = deps.ids.next<'Invitation'>();
  const agentAccountId = params.agentAccountId ?? deps.ids.next<'Account'>();
  const shown = deps.codes.issue();
  const normalisedCode = normaliseHandoverCode(shown);
  if (normalisedCode === null) throw new Error('issueAgentInvitation: a malformed handover code');
  const invitation = Invitation.issueAgent({
    id: invitationId,
    marketId: market.marketId,
    email: params.email,
    displayName: params.displayName,
    agentAccountId,
    handoverCodeHmac: deps.codes.hmacOf(market, invitationId, normalisedCode),
    invitedByAccountId: actor.accountId,
    now,
  });
  await deps.invitations.add(market, invitation);
  await deps.outbox.append(context, invitation.pendingEvents);
  await deps.audit.record(
    context,
    AgentInvitationIssuedAudit.entry(invitationId, { after: { agentAccountId } }),
  );
  return ok({ accountId: agentAccountId, invitationId, handoverCode: shown });
}

/** Revokes a loaded pending agent invitation in the caller's open unit, with its event and audit. */
export async function revokeAgentInvitation(
  deps: Pick<AgentInvitationDependencies, 'invitations' | 'outbox' | 'audit' | 'clock'>,
  context: CallContext,
  invitation: Invitation,
): Promise<boolean> {
  const { market } = context;
  const agentAccountId = invitation.state.agentAccountId;
  if (agentAccountId === null || !invitation.revoke(deps.clock.now()).ok) return false;
  await deps.invitations.save(market, invitation);
  await deps.outbox.append(context, invitation.pendingEvents);
  await deps.audit.record(
    context,
    AgentInvitationRevokedAudit.entry(invitation.state.id, { after: { agentAccountId } }),
  );
  return true;
}

async function reserveAgentInvitationMail(
  deps: Pick<AgentInvitationDependencies, 'throttles' | 'keys' | 'policy'>,
  market: MarketContext,
  emailNormalized: string,
  now: Temporal.Instant,
) {
  const accountKey = deps.keys.account(market, 'agent', emailNormalized);
  const counters: readonly ThrottleCounter[] = [
    {
      kind: 'mail.account',
      keyHash: accountKey,
      accountKey,
      rule: deps.policy.mailThrottles(market).account,
    },
  ];
  const reservations = await deps.throttles.reserve(market, counters, now);
  return reservationVerdict(
    reservations.map((reservation, index) => ({ reservation, rule: counters[index]!.rule })),
    now,
  );
}
