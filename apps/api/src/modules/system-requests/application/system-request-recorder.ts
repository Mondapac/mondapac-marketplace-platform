import type { CallContext, Result } from '@mondapac/shared-kernel';
import type {
  AppliedChange,
  RecordedRequest,
  RecordFailure,
  SystemRequestRecorder,
} from '../contracts/recorder';
import type { PolicyArea, Risk } from '../domain/areas';
import { areaPolicyOf, recordAppliedChange } from './request-flow';
import type { SystemRequestsDependencies } from './system-requests-dependencies';

/**
 * The {@link SystemRequestRecorder} other modules call in the unit of their change. Like the
 * platform's step-up consumer (which identity implements for every module's use case), it is not
 * a use case: it runs inside the caller's open unit, where the use-case gate (whose
 * authorisation check opens a unit of its own) cannot run. The caller's own use case already
 * passed its gate; this only adds the review of what that use case changed.
 */
export class SystemRequestRecorderImplementation implements SystemRequestRecorder {
  constructor(private readonly deps: SystemRequestsDependencies) {}

  openReview(
    context: CallContext,
    change: AppliedChange,
  ): Promise<Result<RecordedRequest | null, RecordFailure>> {
    return recordAppliedChange(this.deps, context, change);
  }

  areaPolicy(
    context: CallContext,
    area: PolicyArea,
  ): Promise<{ readonly enabled: boolean; readonly risk: Risk }> {
    return areaPolicyOf(this.deps, context, area);
  }
}
