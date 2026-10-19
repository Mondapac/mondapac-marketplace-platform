import { err, parseId } from '@mondapac/shared-kernel';
import type { Clock, Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { closeProposal, type ProposalAction } from '../../domain/registry';
import { typeRevisionDiff, type TypeRevisionDiffEntry } from '../../domain/type-revision';
import type { ChangeReasonRead, RegistryCipher } from '../ports/registry-cipher';
import type {
  CertificationRegistryRepository,
  StoredProposal,
  StoredTypeRevision,
} from '../ports/registry.repository';
import { invalid, type ValidationFailure } from '../review/review.shared';

/** The ports the registry use cases share (certification slice 12); each uses its part. */
export interface RegistryDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly registry: CertificationRegistryRepository;
  readonly cipher: RegistryCipher;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The Market's `supportedLocales` (a type revision names every one). */
  readonly supportedLocales: (market: MarketContext) => readonly string[];
}

export { reviewerOf as adminOf, reviewFailure as registryFailure } from '../review/review.shared';

export function parseTypeId(raw: unknown): Id<'CertificationType'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'CertificationType'>(raw);
  return parsed.ok ? parsed.value : null;
}

export function parseRegistryIssuerId(raw: unknown): Id<'Issuer'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'Issuer'>(raw);
  return parsed.ok ? parsed.value : null;
}

export function parseProposalId(raw: unknown): Id<'RelaxationProposal'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'RelaxationProposal'>(raw);
  return parsed.ok ? parsed.value : null;
}

/** A row version as the client read it: a positive whole number in the column's range. */
export function versionIn(
  value: unknown,
): { ok: true; value: number } | { ok: false; error: ValidationFailure } {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_646) {
    return { ok: false, error: invalid('version', 'format').error };
  }
  return { ok: true, value };
}

export type Allowed =
  { readonly allowed: true } | { readonly allowed: false; readonly code: string };

/** The read shape of a pending relaxation (design 7.6), as the panel shows it. */
export interface RelaxationProposalView {
  readonly id: string;
  readonly subject: StoredProposal['subject'];
  readonly subjectId: string;
  readonly basedOnRevisionId: string | null;
  readonly proposedRevisionId: string | null;
  /** The display name waits for identity's R-11 read of admin names (open item). */
  readonly proposer: { readonly accountId: string };
  readonly proposedAt: string;
  readonly reason: ChangeReasonRead | null;
  readonly diff: readonly TypeRevisionDiffEntry[];
  readonly state: StoredProposal['state'];
  readonly decidedBy: { readonly accountId: string } | null;
  readonly decidedAt: string | null;
  readonly version: number;
  readonly actions: {
    readonly approve: Allowed;
    readonly reject: Allowed;
    readonly withdraw: Allowed;
  };
}

function allowedFor(proposal: StoredProposal, action: ProposalAction, actor: string): Allowed {
  const answer = closeProposal(proposal, action, actor);
  return answer.ok ? { allowed: true } : { allowed: false, code: answer.error.code };
}

/**
 * Builds the view of a proposal. The change reason is opened here, outside any unit: from the
 * proposed revision for a type revision, from the proposal for a reactivation (design 3.7). The
 * actions are the closing rules for the reading admin (the edit key is the use case's to check:
 * the panel asks again on the action).
 */
export async function proposalView(
  deps: Pick<RegistryDependencies, 'cipher'>,
  market: MarketContext,
  proposal: StoredProposal,
  actorAccountId: string,
  revisions: {
    readonly based: StoredTypeRevision | null;
    readonly proposed: StoredTypeRevision | null;
  },
): Promise<RelaxationProposalView> {
  let reason: ChangeReasonRead | null = null;
  if (proposal.subject === 'type-revision' && revisions.proposed !== null) {
    const { proposed } = revisions;
    reason =
      proposed.changeReasonCiphertext === null
        ? null
        : await deps.cipher.openChangeReason(market, proposed.id, proposed.changeReasonCiphertext);
  } else if (proposal.changeReasonCiphertext !== null) {
    reason = await deps.cipher.openChangeReason(
      market,
      proposal.id,
      proposal.changeReasonCiphertext,
    );
  }
  let diff: readonly TypeRevisionDiffEntry[] = [];
  if (proposal.subject === 'type-revision' && revisions.based !== null && revisions.proposed) {
    diff = typeRevisionDiff(revisions.based.content, revisions.proposed.content);
  } else if (proposal.subject === 'type-reactivation') {
    diff = [{ path: 'status', before: 'inactive', after: 'active', relaxes: true }];
  } else if (proposal.subject === 'issuer-reactivation') {
    diff = [{ path: 'state', before: 'closed-to-new', after: 'active', relaxes: true }];
  }
  return {
    id: proposal.id,
    subject: proposal.subject,
    subjectId: proposal.subjectId,
    basedOnRevisionId: proposal.basedOnRevisionId,
    proposedRevisionId: proposal.proposedRevisionId,
    proposer: { accountId: proposal.proposerAccountId },
    proposedAt: proposal.proposedAt.toString(),
    reason,
    diff,
    state: proposal.state,
    decidedBy:
      proposal.decidedByAccountId === null ? null : { accountId: proposal.decidedByAccountId },
    decidedAt: proposal.decidedAt === null ? null : proposal.decidedAt.toString(),
    version: proposal.version,
    actions: {
      approve: allowedFor(proposal, 'approve', actorAccountId),
      reject: allowedFor(proposal, 'reject', actorAccountId),
      withdraw: allowedFor(proposal, 'withdraw', actorAccountId),
    },
  };
}

/** A refusal of a proposal action for a proposal that is not this subject's (or not found). */
export const PROPOSAL_NOT_FOUND = err({ code: 'proposal.not-found' } as const);

export type { ValidationFailure };
export { invalid };
