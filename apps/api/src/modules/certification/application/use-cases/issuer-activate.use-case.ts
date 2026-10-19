import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';
import { IssuerActivatedAudit } from '../../domain/audit';
import { activate, type IssuerProblem } from '../../domain/issuer';
import { expertApprovalIn } from '../../domain/registry';
import {
  adminOf,
  invalid,
  parseRegistryIssuerId,
  registryFailure,
  versionIn,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface IssuerActivateInput {
  readonly issuerId: unknown;
  readonly version: unknown;
  /** `{ confirmedBy, reference }`: who confirmed and a document or note reference. */
  readonly expertApproval: unknown;
}

export interface IssuerActivateOutput {
  readonly issuerId: string;
  readonly state: 'active';
  readonly version: number;
}

export type IssuerActivateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'issuer.not-found' }
  | { readonly code: 'conflict.stale' }
  | IssuerProblem
  | ValidationFailure;

/**
 * `issuers.activate` (certification design 3.5 row 2; brief s5; AC 19): `proposed` → `active` only
 * with an expert approval reference, which is sealed under the Market's platform key outside the
 * unit (CE7; the column CHECK refuses an active issuer without one). The issuer becomes selectable
 * in sellers' forms of its type. One unit: the state and reference under the version,
 * `certification.issuer.activated`. A `closed-to-new` issuer goes back to `active` only by a
 * second admin's approval of a reactivation (H1), never here. Rule: key
 * `certification.issuer.edit` (protected), not acting-as.
 */
export class IssuerActivate extends UseCase<
  IssuerActivateInput,
  IssuerActivateOutput,
  IssuerActivateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-activate',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegistryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssuerActivateInput,
  ): Promise<Result<IssuerActivateOutput, IssuerActivateFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const issuerId = parseRegistryIssuerId(input.issuerId);
    if (issuerId === null) return invalid('issuerId', 'format');
    const version = versionIn(input.version);
    if (!version.ok) return err(version.error);
    const approval = expertApprovalIn(input.expertApproval);
    if (!approval.ok) {
      return invalid(
        approval.path === '' ? 'expertApproval' : `expertApproval.${approval.path}`,
        approval.code,
      );
    }
    const { deps } = this;
    const { market } = context;

    let sealed: string;
    try {
      sealed = await deps.cipher.sealExpertApproval(market, 'issuer', approval.value);
    } catch (error) {
      return registryFailure(context, 'certification.issuer-activate.seal', error);
    }
    const now = deps.clock.now();
    return deps.unitOfWork
      .run<IssuerActivateOutput, IssuerActivateFailure>(market, async () => {
        const issuer = await deps.registry.issuer(market, issuerId);
        if (issuer === null) return err({ code: 'issuer.not-found' } as const);
        const next = activate(
          { state: issuer.state, expertApproval: null, reactivation: null },
          approval.value,
        );
        if (!next.ok) return err(next.error);
        if (issuer.version !== version.value) return err({ code: 'conflict.stale' } as const);
        await deps.registry.setIssuerState(market, {
          id: issuerId,
          expectedVersion: version.value,
          state: 'active',
          expertReferenceCiphertext: sealed,
          accountId: admin.accountId,
          changedAt: now,
        });
        await deps.audit.record(
          context,
          IssuerActivatedAudit.entry(issuerId, { after: { typeId: issuer.typeId } }),
        );
        return ok({ issuerId, state: 'active' as const, version: version.value + 1 });
      })
      .catch((error: unknown) => registryFailure(context, 'certification.issuer-activate', error));
  }
}
