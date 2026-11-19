import type { CallContext } from '@mondapac/shared-kernel';
import type { ExportFile } from '../../../../platform/list-export';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_REQUEST_VIEW } from '../../contracts/permissions';
import {
  exportRequests,
  type ExportFailure,
  type SystemRequestsExportDependencies,
} from '../export-flow';

export { EXPORT_COLUMNS } from '../export-flow';

/**
 * `system-requests.export-system-requests`: the System requests queue as a CSV or XLSX file, the
 * chosen rows or every row of the list's view, search and filters (at most 10,000). Same key as
 * the list; the rows are the list's, without the values before and after a change.
 */
export class ExportSystemRequests extends UseCase<unknown, ExportFile, ExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.export-system-requests',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_REQUEST_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsExportDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return exportRequests(this.deps, context, input);
  }
}
