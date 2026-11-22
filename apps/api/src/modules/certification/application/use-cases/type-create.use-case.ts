import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import { TypeProposedAudit } from '../../domain/audit';
import { changeReasonIn, newTypeCodeIn } from '../../domain/registry';
import {
  VERIFICATION_MODES,
  validateTypeRevision,
  type TypeRevisionProblem,
  type VerificationMode,
} from '../../domain/type-revision';
import {
  adminOf,
  invalid,
  registryFailure,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';
import { typeRevisionContentIn } from '../registry/type-content';

/** The create use case also knows the Market's seed codes, which a new type never takes. */
export interface TypeCreateDependencies extends RegistryDependencies {
  readonly reservedTypeCodes: (market: MarketContext) => readonly string[];
}

export interface TypeCreateInput {
  readonly code: unknown;
  readonly content: unknown;
  /** Optional, at most 500 characters; sealed under the proposal's key (design 3.7). */
  readonly reason?: unknown;
}

export interface TypeCreateOutput {
  readonly typeId: string;
  readonly proposalId: string;
  readonly status: 'proposed';
  readonly revisionId: string;
  /** The proposal's version, which the approving admin sends back. */
  readonly proposalVersion: number;
}

export type TypeCreateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'type.code-taken' }
  | { readonly code: 'type.code-reserved' }
  | {
      readonly code: 'type.revision-invalid';
      readonly issues: readonly TypeRevisionProblem[];
    }
  | ValidationFailure;

const logger = new Logger('CertificationTypeCreate');

/**
 * `types.create` (new-type design 2, 5; FE-091): an admin proposes a new certification type. One
 * unit writes the type `proposed`, its first revision with texts and claim terms, the pointer, and
 * a pending `type-creation` proposal based on that revision; the optional reason is sealed under
 * the proposal's own key (CE8). Nothing is live: sellers and customers do not see the type and
 * its terms are not matched until a second admin approves it (`type-approve-creation`). The code
 * follows the type code pattern, is never a seed code of the Market (`type.code-reserved`) and is
 * never reused, whatever the status of the type that holds it (`type.code-taken`, 409). The
 * content passes `validateTypeRevision` against the Market's locales as a first revision. Audit
 * `certification.type.proposed` (ids and numbers only), `relaxation-proposed.v1`. Not reviewed in
 * System requests: the second admin is the check. Rule: key `certification.type.edit`
 * (protected), the admin population, not acting-as.
 */
export class TypeCreate extends UseCase<TypeCreateInput, TypeCreateOutput, TypeCreateFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.type-create',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_TYPE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TypeCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TypeCreateInput,
  ): Promise<Result<TypeCreateOutput, TypeCreateFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const { deps } = this;
    const { market } = context;
    const code = newTypeCodeIn(input.code, deps.reservedTypeCodes(market));
    if (!code.ok) {
      if (code.code === 'type.code-reserved') return err({ code: 'type.code-reserved' });
      return invalid('code', code.code);
    }
    const reason = changeReasonIn(input.reason);
    if (!reason.ok) return invalid('reason', reason.code);
    const mode = verificationModeOf(input.content);
    if (mode === null) return invalid('content.verificationMode', 'format');
    const parsed = typeRevisionContentIn(input.content, mode);
    if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.problems });
    const checked = validateTypeRevision(
      parsed.value,
      deps.supportedLocales(market),
      null,
      deps.badgeArtworkKeys,
    );
    if (!checked.ok) return err({ code: 'type.revision-invalid', issues: checked.error });
    const content = checked.value;

    const now = deps.clock.now();
    const typeId = deps.ids.next<'CertificationType'>();
    const revisionId = deps.ids.next<'CertificationTypeRevision'>();
    const proposalId = deps.ids.next<'RelaxationProposal'>();
    const result = await deps.unitOfWork
      .run<TypeCreateOutput, TypeCreateFailure>(market, async () => {
        const taken = await deps.registry.createType(market, {
          typeId,
          code: code.value,
          revision: {
            id: revisionId,
            content,
            authorAccountId: admin.accountId,
            changeReasonCiphertext: null,
            createdAt: now,
          },
        });
        if (taken !== null) return err({ code: taken } as const);
        const reasonCiphertext =
          reason.value === null
            ? null
            : await deps.cipher.sealChangeReason(market, proposalId, reason.value);
        const refused = await deps.registry.addProposal(market, {
          id: proposalId,
          subject: 'type-creation',
          subjectId: typeId,
          basedOnRevisionId: revisionId,
          proposedRevisionId: null,
          proposedExpertReferenceCiphertext: null,
          proposerAccountId: admin.accountId,
          changeReasonCiphertext: reasonCiphertext,
          proposedAt: now,
        });
        // A new type has no proposal yet; a refusal here is a fault, not an answer.
        if (refused !== null) throw new Error('a new certification type already has a proposal');
        await deps.audit.record(
          context,
          TypeProposedAudit.entry(typeId, {
            after: {
              proposalId,
              revisionId,
              revisionNo: 1,
              reasonGiven: reasonCiphertext !== null,
            },
          }),
        );
        // No `relaxation-proposed.v1`: its subject enum is a published contract without
        // `type-creation` (see PROPOSAL_SUBJECTS).
        return ok({
          typeId,
          proposalId,
          status: 'proposed' as const,
          revisionId,
          proposalVersion: 1,
        });
      })
      .catch((error: unknown) => registryFailure(context, 'certification.type-create', error));
    if (result.ok) {
      logger.log({
        msg: 'certification.type.proposed',
        typeId,
        proposalId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return result;
  }
}

/** The mode the content names: the parser needs it, and it never changes after this insert. */
function verificationModeOf(content: unknown): VerificationMode | null {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null;
  const mode = (content as Record<string, unknown>).verificationMode;
  return (VERIFICATION_MODES as readonly unknown[]).includes(mode)
    ? (mode as VerificationMode)
    : null;
}
