import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_VIEW } from '../../contracts/permissions';
import {
  listIssuerRequests,
  type IssuerRequestListDependencies,
  type IssuerRequestListFailure,
  type IssuerRequestListInput,
  type IssuerRequestListPage,
} from '../issuer-requests/issuer-request-list-flow';

/**
 * `certification.issuer-requests-query` (super list 36): an admin lists the open issuer requests of the Market with filters, sort, page numbers or Previous/Next and each row's actions. Same key as the older queue
 * (`certification.issuer.view`); it reads the same requests.
 */
export class IssuerRequestsQuery extends UseCase<
  IssuerRequestListInput,
  IssuerRequestListPage,
  IssuerRequestListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-requests-query',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: IssuerRequestListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: IssuerRequestListInput) {
    return listIssuerRequests(this.deps, context, input);
  }
}
