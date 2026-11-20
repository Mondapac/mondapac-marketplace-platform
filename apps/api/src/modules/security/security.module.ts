import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { ExceljsSheetWriter, SHEET_WRITER, type SheetWriter } from '../../platform/list-export';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { SECURITY_EVENT_FEED } from '../../platform/security-events/security-event-feed';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { IdentityModule } from '../identity';
import { ListsModule, registerLists } from '../lists';
import { ADMIN_NAMES } from './application/ports/admin-names';
import { ALERT_MESSENGER } from './application/ports/alert-messenger';
import { ON_CALL_ROSTER } from './application/ports/on-call-roster';
import { SECURITY_ALERT_REPOSITORY } from './application/ports/security-alert.repository';
import { ALERT_ROW_KEYS, type AlertListDependencies } from './application/alert-list-flow';
import type { SecurityDependencies } from './application/security-dependencies';
import { SECURITY_ALERT_LISTS } from './application/alert-saved-filter-list';
import { AlertRespondProbe } from './application/use-cases/alert-respond-probe.use-case';
import { AcknowledgeSecurityAlert } from './application/use-cases/acknowledge-security-alert.use-case';
import { DeliverSecurityAlerts } from './application/use-cases/deliver-security-alerts.use-case';
import { EvaluateSecurityRules } from './application/use-cases/evaluate-security-rules.use-case';
import { ExportSecurityAlerts } from './application/use-cases/export-security-alerts.use-case';
import { ListSecurityAlerts } from './application/use-cases/list-security-alerts.use-case';
import { QuerySecurityAlerts } from './application/use-cases/query-security-alerts.use-case';
import { ResolveSecurityAlert } from './application/use-cases/resolve-security-alert.use-case';
import { SendSecurityDigests } from './application/use-cases/send-security-digests.use-case';
import { ViewOnCall } from './application/use-cases/view-on-call.use-case';
import { ViewSecurityAlert } from './application/use-cases/view-security-alert.use-case';
import { ViewSecuritySummary } from './application/use-cases/view-security-summary.use-case';
import { SECURITY_AUDIT_ACTIONS, SECURITY_PERMISSIONS } from './contracts';
import { securityProviders } from './infrastructure/security-providers';
import {
  deliverAlertsJob,
  evaluateRulesJob,
  sendDigestsJob,
} from './presentation/jobs/security.jobs';
import { AdminSecurityController } from './presentation/security.controller';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: SecurityDependencies) => U;

const PORTS: readonly [keyof SecurityDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['alerts', SECURITY_ALERT_REPOSITORY],
  ['events', SECURITY_EVENT_FEED],
  ['roster', ON_CALL_ROSTER],
  ['messenger', ALERT_MESSENGER],
  ['audit', AUDIT_WRITER],
  ['names', ADMIN_NAMES],
  ['clock', CLOCK],
  ['ids', ID_GENERATOR],
];

/** Every security use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as SecurityDependencies,
      ),
  };
}

type AlertListUseCaseClass<U> = new (gate: UseCaseGate, deps: AlertListDependencies) => U;

/** The alert list and its export (super list 37) share one dependency object. */
function alertListUseCaseProvider<U>(type: AlertListUseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [
      USE_CASE_GATE,
      UNIT_OF_WORK,
      SECURITY_ALERT_REPOSITORY,
      ON_CALL_ROSTER,
      ADMIN_NAMES,
      AlertRespondProbe,
      SHEET_WRITER,
      CLOCK,
    ],
    useFactory: (
      gate: UseCaseGate,
      unitOfWork: AlertListDependencies['unitOfWork'],
      alerts: AlertListDependencies['alerts'],
      roster: AlertListDependencies['roster'],
      names: AlertListDependencies['names'],
      respond: AlertRespondProbe,
      sheetWriter: AlertListDependencies['sheetWriter'],
      clock: AlertListDependencies['clock'],
    ) => {
      const [respondKey] = ALERT_ROW_KEYS;
      return new type(gate, {
        unitOfWork,
        alerts,
        roster,
        names,
        probes: { [respondKey]: respond },
        sheetWriter,
        clock,
      });
    },
  };
}

/**
 * Security (the SOC; docs/design/data/security.md): package 2, the rules over the security events
 * of package 1, the alerts they open, their delivery by severity with the s1 escalation, the
 * digests, and the admin API to acknowledge and resolve them. Tables in the `security` schema.
 * The events are read through the platform's feed, bound into this module alone.
 */
@Module({
  imports: [IdentityModule, ListsModule],
  controllers: [AdminSecurityController],
  providers: [
    PersistenceModule.auditWriterFor('security'),
    PersistenceModule.securityEventFeedFor('security'),
    registerAuditActions('security', SECURITY_AUDIT_ACTIONS),
    registerPermissions('security', SECURITY_PERMISSIONS),
    registerLists('security', SECURITY_ALERT_LISTS),
    ...securityProviders,
    { provide: SHEET_WRITER, useFactory: (): SheetWriter => new ExceljsSheetWriter() },
    ...[
      EvaluateSecurityRules,
      DeliverSecurityAlerts,
      SendSecurityDigests,
      ListSecurityAlerts,
      ViewSecurityAlert,
      ViewSecuritySummary,
      ViewOnCall,
      AcknowledgeSecurityAlert,
      ResolveSecurityAlert,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: AlertRespondProbe,
      inject: [USE_CASE_GATE],
      useFactory: (gate: UseCaseGate) => new AlertRespondProbe(gate),
    },
    alertListUseCaseProvider(QuerySecurityAlerts),
    alertListUseCaseProvider(ExportSecurityAlerts),
    registerJobsFrom(
      'security',
      [EvaluateSecurityRules, DeliverSecurityAlerts, SendSecurityDigests],
      (
        evaluate: EvaluateSecurityRules,
        deliver: DeliverSecurityAlerts,
        send: SendSecurityDigests,
      ) => [evaluateRulesJob(evaluate), deliverAlertsJob(deliver), sendDigestsJob(send)],
    ),
  ],
})
export class SecurityModule {}
