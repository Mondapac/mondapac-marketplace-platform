import { Global, Module } from '@nestjs/common';
import { AuditActionCatalogue } from './audit-action-catalogue';

/**
 * The audit (docs/design/domain/platform-audit.md 2): the action catalogue every module and
 * platform component registers with. The writer itself is implemented by the persistence
 * module (`platform/persistence/audit/`) and bound per module with
 * `PersistenceModule.auditWriterFor`; there is no injectable writer factory.
 */
@Global()
@Module({
  providers: [AuditActionCatalogue],
  exports: [AuditActionCatalogue],
})
export class AuditModule {}
