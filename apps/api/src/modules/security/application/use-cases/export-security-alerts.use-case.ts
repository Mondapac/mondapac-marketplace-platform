import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { SECURITY_VIEW } from '../../contracts/permissions';
import {
  exportAlertRows,
  type AlertExportInput,
  type AlertListDependencies,
  type AlertListFailure,
} from '../alert-list-flow';

/** `security.export-security-alerts` (super list 37): the alert list as CSV or XLSX. */
export class ExportSecurityAlerts extends UseCase<AlertExportInput, ExportFile, AlertListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'security.export-security-alerts',
    rule: { kind: 'permissions', allOf: [SECURITY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AlertListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: AlertExportInput) {
    return exportAlertRows(this.deps, context, input);
  }
}
