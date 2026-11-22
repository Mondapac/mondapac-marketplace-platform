import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  backfillHistory,
  type BackfillCounts,
  type BackfillDependencies,
} from '../backfill-history';
import type { SourceUnavailable } from '../ports/report-sources';

/**
 * `reporting.backfill-history`: one run of the history backfill (dashboards upgrade phase 3, PR 12).
 * Rule `system`. Reads the next pages of every seller order and refund recorded before the backfill
 * started from their owners and records them, going on from the saved cursor.
 */
export class BackfillHistory extends UseCase<
  Record<string, never>,
  BackfillCounts,
  SourceUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.backfill-history',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BackfillDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<BackfillCounts, SourceUnavailable>> {
    return backfillHistory(this.deps, context);
  }
}
