import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CertificationTypeView } from '../../contracts/certification.facade';
import { certificationTypesFor, type QueryFailure } from '../queries';
import type { PublishedTypesReader } from '../ports/published-types.reader';

export interface CertificationTypesInput {
  readonly filter: { readonly status?: 'active' | 'inactive' };
}

/** `certificationTypes` for request actors: rule `anonymous`; its pair is the `system` case. The answer is the same for every caller. */
export class CertificationTypes extends UseCase<
  CertificationTypesInput,
  readonly CertificationTypeView[],
  QueryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.certification-types',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly reader: PublishedTypesReader,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CertificationTypesInput,
  ): Promise<Result<readonly CertificationTypeView[], QueryFailure>> {
    return certificationTypesFor(this.reader, context, input.filter);
  }
}
