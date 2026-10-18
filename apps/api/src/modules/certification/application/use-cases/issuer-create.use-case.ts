import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';
import { IssuerCreatedAudit } from '../../domain/audit';
import { accreditationNumberIn, issuerNameIn, issuerNameKey } from '../../domain/registry';
import {
  adminOf,
  invalid,
  parseTypeId,
  registryFailure,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface IssuerCreateInput {
  readonly typeId: unknown;
  readonly displayName: unknown;
  readonly accreditationNumber?: unknown;
}

export interface IssuerCreateOutput {
  readonly issuerId: string;
  readonly typeId: string;
  readonly state: 'proposed';
  readonly version: number;
}

export type IssuerCreateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'type.not-found' }
  | { readonly code: 'issuer.name-taken' }
  | { readonly code: 'issuer.accreditation-taken' }
  | ValidationFailure;

/**
 * `issuers.create` (certification design 3.5 row 1; CERT-04; slice 12): an admin adds an issuer of
 * one type of the Market, `proposed`, not selectable until it is activated with an expert approval
 * reference. Two entries of one type a seller cannot tell apart are refused (`issuer.name-taken`,
 * the unique name key), as is a taken accreditation number. One unit: the row and
 * `certification.issuer.created`. Rule: key `certification.issuer.edit` (protected), not
 * acting-as.
 */
export class IssuerCreate extends UseCase<
  IssuerCreateInput,
  IssuerCreateOutput,
  IssuerCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-create',
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
    input: IssuerCreateInput,
  ): Promise<Result<IssuerCreateOutput, IssuerCreateFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const typeId = parseTypeId(input.typeId);
    if (typeId === null) return invalid('typeId', 'format');
    const name = issuerNameIn(input.displayName);
    if (!name.ok) return invalid('displayName', name.code);
    const accreditation = accreditationNumberIn(input.accreditationNumber);
    if (!accreditation.ok) return invalid('accreditationNumber', accreditation.code);
    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const issuerId = deps.ids.next<'Issuer'>();
    return deps.unitOfWork
      .run<IssuerCreateOutput, IssuerCreateFailure>(market, async () => {
        if ((await deps.registry.type(market, typeId)) === null) {
          return err({ code: 'type.not-found' } as const);
        }
        const refused = await deps.registry.addIssuer(market, {
          id: issuerId,
          typeId,
          displayName: name.value,
          displayNameKey: issuerNameKey(name.value),
          accreditationNumber: accreditation.value,
          accountId: admin.accountId,
          createdAt: now,
        });
        if (refused !== null) return err({ code: refused } as const);
        await deps.audit.record(
          context,
          IssuerCreatedAudit.entry(issuerId, {
            after: { typeId, accreditationNumberGiven: accreditation.value !== null },
          }),
        );
        return ok({ issuerId, typeId, state: 'proposed' as const, version: 1 });
      })
      .catch((error: unknown) => registryFailure(context, 'certification.issuer-create', error));
  }
}
