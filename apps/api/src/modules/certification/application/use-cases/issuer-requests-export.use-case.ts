import type { CallContext } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_VIEW } from '../../contracts/permissions';
import {
  exportIssuerRequests,
  type IssuerRequestListDependencies,
  type IssuerRequestListFailure,
  type IssuerRequestListInput,
} from '../issuer-requests/issuer-request-list-flow';

/**
 * `certification.issuer-requests-export` (super list 36): an admin exports the open issuer requests of the list as CSV or XLSX. Same key as the older queue
 * (`certification.issuer.view`); it reads the same requests.
 */
export class IssuerRequestsExport extends UseCase<
  IssuerRequestListInput,
  ExportFile,
  IssuerRequestListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-requests-export',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: IssuerRequestListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: IssuerRequestListInput) {
    return exportIssuerRequests(this.deps, context, input);
  }
}
