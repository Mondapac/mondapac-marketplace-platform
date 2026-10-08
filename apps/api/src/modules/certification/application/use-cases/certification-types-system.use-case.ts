import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CertificationTypeView } from '../../contracts/certification.facade';
import { certificationTypesFor, type QueryFailure } from '../queries';
import type { PublishedTypesReader } from '../ports/published-types.reader';

export interface CertificationTypesSystemInput {
  readonly filter: { readonly status?: 'active' | 'inactive' };
}

/** `certificationTypes` for event handlers and jobs: rule `system`; the same answer. The answer is the same for every caller. */
export class CertificationTypesSystem extends UseCase<
  CertificationTypesSystemInput,
  readonly CertificationTypeView[],
  QueryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.certification-types-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly reader: PublishedTypesReader,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CertificationTypesSystemInput,
  ): Promise<Result<readonly CertificationTypeView[], QueryFailure>> {
    return certificationTypesFor(this.reader, context, input.filter);
  }
}
