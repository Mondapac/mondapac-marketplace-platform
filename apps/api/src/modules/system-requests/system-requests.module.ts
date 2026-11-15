import {
  Global,
  Inject,
  Module,
  type FactoryProvider,
  type InjectionToken,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import {
  AUTHORISATION_CHECK,
  registerPermissions,
  registerStepUpActions,
  STEP_UP_CONSUMER,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { IdentityModule } from '../identity';
import { POLICY_REPOSITORY } from './application/ports/policy.repository';
import { REQUEST_REPOSITORY } from './application/ports/request.repository';
import { DUE_DAYS_KIND, POLICY_AREA_KIND, PolicyReverter } from './application/policy-flow';
import { ReverterRegistry } from './application/reverter-registry';
import { SystemRequestRecorderImplementation } from './application/system-request-recorder';
import type { SystemRequestsDependencies } from './application/system-requests-dependencies';
import { ApproveSystemRequest } from './application/use-cases/approve-system-request.use-case';
import { ApproveSystemRequests } from './application/use-cases/approve-system-requests.use-case';
import { ChangeAreaReviewPolicy } from './application/use-cases/change-area-review-policy.use-case';
import { ChangeReviewDueDays } from './application/use-cases/change-review-due-days.use-case';
import { CommentOnSystemRequest } from './application/use-cases/comment-on-system-request.use-case';
import { CountSystemRequests } from './application/use-cases/count-system-requests.use-case';
import { ListSystemRequests } from './application/use-cases/list-system-requests.use-case';
import { RejectSystemRequest } from './application/use-cases/reject-system-request.use-case';
import { ViewReviewPolicy } from './application/use-cases/view-review-policy.use-case';
import { ViewSystemRequest } from './application/use-cases/view-system-request.use-case';
import { WithdrawSystemRequest } from './application/use-cases/withdraw-system-request.use-case';
import {
  SYSTEM_CHANGE_REVERTERS,
  SYSTEM_REQUEST_RECORDER,
  SYSTEM_REQUESTS_AUDIT_ACTIONS,
  SYSTEM_REQUESTS_PERMISSIONS,
  SYSTEM_REQUESTS_STEP_UP_ACTIONS,
} from './contracts';
import { systemRequestsProviders } from './infrastructure/system-requests-providers';
import { SystemRequestsController } from './presentation/system-requests.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: SystemRequestsDependencies) => U;

/** The one dependency object of the module, shared by its use cases, recorder and reverters. */
const DEPENDENCIES = Symbol('SYSTEM_REQUESTS_DEPENDENCIES');
const POLICY_AREA_REVERTER = Symbol('SYSTEM_REQUESTS_POLICY_AREA_REVERTER');
const DUE_DAYS_REVERTER = Symbol('SYSTEM_REQUESTS_DUE_DAYS_REVERTER');
/** The registry itself (lookup and seal), kept inside the module; others get its facade. */
const REVERTER_REGISTRY = Symbol('SYSTEM_REQUESTS_REVERTER_REGISTRY');

const PORTS: readonly [keyof SystemRequestsDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['requests', REQUEST_REPOSITORY],
  ['policy', POLICY_REPOSITORY],
  ['reverters', REVERTER_REGISTRY],
  ['authorisation', AUTHORISATION_CHECK],
  ['stepUp', STEP_UP_CONSUMER],
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, DEPENDENCIES],
    useFactory: (gate: UseCaseGate, deps: SystemRequestsDependencies) => new type(gate, deps),
  };
}

/**
 * System requests (Admin Inbox › System requests; owner decisions of 15 Nov 2026): the review
 * queue of changes to the platform's high-risk areas. A change goes live at once and its module
 * opens a review request here through `SYSTEM_REQUEST_RECORDER`, in the unit of the change; a
 * second admin approves it, or rejects it and the module's registered reverter restores the value
 * before. The review policy (which areas are reviewed, their risk, the review period) lives here
 * and is itself reviewed.
 *
 * Global, so the modules of the reviewed areas (identity among them, which this module imports
 * for the authorisation check) reach the recorder and the reverter registry without importing
 * this module, and without a module cycle (as `CatalogReferencesModule`).
 */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [SystemRequestsController],
  providers: [
    PersistenceModule.auditWriterFor('system-requests'),
    registerAuditActions('system-requests', SYSTEM_REQUESTS_AUDIT_ACTIONS),
    registerPermissions('system-requests', SYSTEM_REQUESTS_PERMISSIONS),
    registerStepUpActions('system-requests', SYSTEM_REQUESTS_STEP_UP_ACTIONS),
    ...systemRequestsProviders,
    { provide: REVERTER_REGISTRY, useFactory: () => new ReverterRegistry() },
    {
      provide: SYSTEM_CHANGE_REVERTERS,
      inject: [REVERTER_REGISTRY],
      useFactory: (registry: ReverterRegistry) => registry.facade,
    },
    {
      provide: DEPENDENCIES,
      inject: PORTS.map(([, token]) => token),
      useFactory: (...values: unknown[]): SystemRequestsDependencies =>
        Object.freeze(
          Object.fromEntries(PORTS.map(([name], index) => [name, values[index]])),
        ) as unknown as SystemRequestsDependencies,
    },
    ...[
      ListSystemRequests,
      CountSystemRequests,
      ViewSystemRequest,
      CommentOnSystemRequest,
      ApproveSystemRequest,
      ApproveSystemRequests,
      RejectSystemRequest,
      WithdrawSystemRequest,
      ViewReviewPolicy,
      ChangeAreaReviewPolicy,
      ChangeReviewDueDays,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: SYSTEM_REQUEST_RECORDER,
      inject: [DEPENDENCIES],
      useFactory: (deps: SystemRequestsDependencies) =>
        new SystemRequestRecorderImplementation(deps),
    },
    {
      provide: POLICY_AREA_REVERTER,
      inject: [DEPENDENCIES],
      useFactory: (deps: SystemRequestsDependencies) => new PolicyReverter(deps, POLICY_AREA_KIND),
    },
    {
      provide: DUE_DAYS_REVERTER,
      inject: [DEPENDENCIES],
      useFactory: (deps: SystemRequestsDependencies) => new PolicyReverter(deps, DUE_DAYS_KIND),
    },
    // The review policy's own kinds, in the area that only this module may use.
    {
      provide: Symbol('system-requests:reverter:own'),
      inject: [REVERTER_REGISTRY, POLICY_AREA_REVERTER, DUE_DAYS_REVERTER],
      useFactory: (registry: ReverterRegistry, area: PolicyReverter, dueDays: PolicyReverter) => {
        registry.register('system-requests', POLICY_AREA_KIND, 'review-policy', area);
        registry.register('system-requests', DUE_DAYS_KIND, 'review-policy', dueDays);
        return true;
      },
    },
  ],
  exports: [SYSTEM_REQUEST_RECORDER, SYSTEM_CHANGE_REVERTERS],
})
export class SystemRequestsModule implements OnApplicationBootstrap {
  constructor(@Inject(REVERTER_REGISTRY) private readonly reverters: ReverterRegistry) {}

  /** Every module has registered its reverters by now: nothing registers later. */
  onApplicationBootstrap(): void {
    this.reverters.seal();
  }
}
