import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SECURITY_VIEW } from '../../contracts/permissions';
import {
  listAlertRows,
  type AlertListDependencies,
  type AlertListFailure,
  type AlertListInput,
  type AlertListPage,
} from '../alert-list-flow';

/**
 * `security.query-security-alerts` (super list 37): the alerts with views, filters, sort, page
 * numbers or Previous/Next, the view counts and the row actions (security.centre.view).
 */
export class QuerySecurityAlerts extends UseCase<AlertListInput, AlertListPage, AlertListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'security.query-security-alerts',
    rule: { kind: 'permissions', allOf: [SECURITY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AlertListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: AlertListInput) {
    return listAlertRows(this.deps, context, input);
  }
}
