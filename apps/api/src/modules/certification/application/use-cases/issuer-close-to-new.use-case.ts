import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';
import { IssuerClosedToNewAudit } from '../../domain/audit';
import { IssuerDeactivated } from '../../domain/events';
import { closeToNew, type IssuerProblem } from '../../domain/issuer';
import {
  adminOf,
  invalid,
  parseRegistryIssuerId,
  registryFailure,
  versionIn,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface IssuerCloseToNewInput {
  readonly issuerId: unknown;
  readonly version: unknown;
}

export interface IssuerCloseToNewOutput {
  readonly issuerId: string;
  readonly state: 'closed-to-new';
  readonly version: number;
}

export type IssuerCloseToNewFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'issuer.not-found' }
  | { readonly code: 'conflict.stale' }
  | IssuerProblem
  | ValidationFailure;

/**
 * `issuers.close-to-new`, deactivation form 1 (certification design 3.5 row 3; Q6; AC 19):
 * `active` → `closed-to-new`. No new submission or approval names the issuer (submit and approve
 * refuse `issuer.not-active`; the approval share-locks the issuer row, so one in flight either
 * commits first or sees this state). Approved certificates stay valid until their own boundary
 * (`validity.ts` admits `closed-to-new`). One unit: the state under the version,
 * `certification.issuer.closed-to-new` and `issuer-deactivated.v1` (`form: closed-to-new`). Rule:
 * key `certification.issuer.edit` (protected), not acting-as.
 */
export class IssuerCloseToNew extends UseCase<
  IssuerCloseToNewInput,
  IssuerCloseToNewOutput,
  IssuerCloseToNewFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-close-to-new',
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
    input: IssuerCloseToNewInput,
  ): Promise<Result<IssuerCloseToNewOutput, IssuerCloseToNewFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const issuerId = parseRegistryIssuerId(input.issuerId);
    if (issuerId === null) return invalid('issuerId', 'format');
    const version = versionIn(input.version);
    if (!version.ok) return err(version.error);
    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    return deps.unitOfWork
      .run<IssuerCloseToNewOutput, IssuerCloseToNewFailure>(market, async () => {
        const issuer = await deps.registry.issuer(market, issuerId);
        if (issuer === null) return err({ code: 'issuer.not-found' } as const);
        const next = closeToNew({ state: issuer.state, expertApproval: null, reactivation: null });
        if (!next.ok) return err(next.error);
        if (issuer.version !== version.value) return err({ code: 'conflict.stale' } as const);
        await deps.registry.setIssuerState(market, {
          id: issuerId,
          expectedVersion: version.value,
          state: 'closed-to-new',
          accountId: admin.accountId,
          changedAt: now,
        });
        await deps.audit.record(
          context,
          IssuerClosedToNewAudit.entry(issuerId, { after: { typeId: issuer.typeId } }),
        );
        await deps.outbox.append(context, [
          IssuerDeactivated.record({
            aggregateId: issuerId,
            aggregateVersion: version.value + 1,
            occurredAt: now,
            payload: { issuerId, form: 'closed-to-new' },
          }),
        ]);
        return ok({ issuerId, state: 'closed-to-new' as const, version: version.value + 1 });
      })
      .catch((error: unknown) =>
        registryFailure(context, 'certification.issuer-close-to-new', error),
      );
  }
}
