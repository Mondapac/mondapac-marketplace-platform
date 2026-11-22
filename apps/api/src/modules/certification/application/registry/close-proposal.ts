import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  RelaxationProposalRejectedAudit,
  RelaxationProposalWithdrawnAudit,
} from '../../domain/audit';
import { closeProposal, type ProposalProblem, type ProposalSubject } from '../../domain/registry';
import {
  adminOf,
  invalid,
  parseProposalId,
  registryFailure,
  versionIn,
  type RegistryDependencies,
  type ValidationFailure,
} from './registry.shared';

export interface CloseProposalInput {
  readonly subjectId: unknown;
  readonly proposalId: unknown;
  /** The proposal's version the admin read. */
  readonly version: unknown;
}

export interface CloseProposalOutput {
  readonly proposalId: string;
  readonly state: 'rejected' | 'withdrawn';
  readonly version: number;
}

export type CloseProposalFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'proposal.not-found' }
  | { readonly code: 'conflict.stale' }
  | ProposalProblem
  | ValidationFailure;

/**
 * The body of the reject and withdraw use cases (design 7.6): `reject` by an admin who is not the
 * proposer, `withdraw` by the proposer only. The proposal must belong to the route's subject and
 * one of `subjects`; one unit moves it under its version and writes its audit row. Nothing else
 * changes: the subject stays as it was (a rejected relaxing revision is never published), except
 * a new type's `type-creation` proposal, which takes its `proposed` type to `rejected` or
 * `withdrawn` in the same unit (FE-091). The caller's use case declares the subject's edit key.
 */
export async function closeSubjectProposal(
  deps: RegistryDependencies,
  context: CallContext,
  input: CloseProposalInput,
  options: {
    readonly action: 'reject' | 'withdraw';
    readonly subjects: readonly ProposalSubject[];
    readonly parseSubjectId: (raw: unknown) => string | null;
    readonly msg: string;
  },
): Promise<Result<CloseProposalOutput, CloseProposalFailure>> {
  const admin = adminOf(context, { write: true });
  if (admin === null) return err({ code: 'access.denied' });
  if (typeof input !== 'object' || input === null) return invalid('body', 'type');
  const subjectId = options.parseSubjectId(input.subjectId);
  if (subjectId === null) return invalid('subjectId', 'format');
  const proposalId = parseProposalId(input.proposalId);
  if (proposalId === null) return invalid('proposalId', 'format');
  const version = versionIn(input.version);
  if (!version.ok) return err(version.error);
  const { market } = context;
  const now = deps.clock.now();
  return deps.unitOfWork
    .run<CloseProposalOutput, CloseProposalFailure>(market, async () => {
      const proposal = await deps.registry.proposal(market, proposalId);
      if (
        proposal === null ||
        proposal.subjectId !== subjectId ||
        !options.subjects.includes(proposal.subject)
      ) {
        return err({ code: 'proposal.not-found' } as const);
      }
      const closed = closeProposal(proposal, options.action, admin.accountId);
      if (!closed.ok) return err(closed.error);
      if (proposal.version !== version.value) return err({ code: 'conflict.stale' } as const);
      const state = closed.value as 'rejected' | 'withdrawn';
      if (proposal.subject === 'type-creation') {
        // A new type's proposal closes the type with it (FE-091): `rejected` or `withdrawn`, for
        // good. Lock order: the type row, then its proposal.
        const type = await deps.registry.typeOfAnyStatus(
          market,
          proposal.subjectId as Id<'CertificationType'>,
        );
        if (type === null || type.status !== 'proposed') {
          throw new Error('a pending type-creation proposal without its proposed type');
        }
        await deps.registry.setTypeStatus(market, type.id, state, type.version);
      }
      await deps.registry.closeProposal(market, {
        id: proposalId,
        expectedVersion: version.value,
        state,
        // Only an approval or a rejection names a decider (data design 3.20 CHECK).
        decidedByAccountId: state === 'rejected' ? admin.accountId : null,
        decidedAt: now,
      });
      const audit =
        state === 'rejected' ? RelaxationProposalRejectedAudit : RelaxationProposalWithdrawnAudit;
      await deps.audit.record(
        context,
        audit.entry(proposalId, {
          after: { subject: proposal.subject, subjectId: proposal.subjectId as Id },
        }),
      );
      return ok({ proposalId, state, version: version.value + 1 });
    })
    .catch((error: unknown) => registryFailure(context, options.msg, error));
}
