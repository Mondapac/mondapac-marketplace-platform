import { isIP } from 'node:net';
import {
  canonicalJson,
  encodePayload,
  isMinted,
  parseCorrelationId,
  parseId,
} from '@mondapac/shared-kernel';
import type {
  ActorContext,
  CallContext,
  Clock,
  IdGenerator,
  JsonObject,
} from '@mondapac/shared-kernel';
import {
  AUDITED_SECURITY_ACTIONS,
  RECORDED_SECURITY_EVENTS,
  type SecuritySeverity,
} from '../../security-events/security-event-catalogue';
import {
  MAX_SECURITY_PAYLOAD_BYTES,
  SecurityEventRefusedError,
  type SecurityEvents,
} from '../../security-events/security-events';
import { unitStorage } from '../unit-store';
import { auditTx } from './audit-transaction';

/** One row of `platform.security_events`, as the guarded delegate takes it. */
export interface SecurityEventRow {
  readonly id: string;
  readonly marketId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly type: string;
  readonly severity: SecuritySeverity;
  readonly actorType: 'USER' | 'SYSTEM' | 'ANONYMOUS';
  readonly actorId: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly ip: string | null;
  readonly payload: JsonObject;
  readonly correlationId: string;
}

/** The actor columns come from the context only, as in the audit log (PA W2). */
export function securityActorColumns(
  actor: ActorContext,
): Pick<SecurityEventRow, 'actorType' | 'actorId'> {
  switch (actor.kind) {
    case 'authenticated':
      return { actorType: 'USER', actorId: actor.accountId };
    case 'system':
      return { actorType: 'SYSTEM', actorId: null };
    case 'anonymous':
      return { actorType: 'ANONYMOUS', actorId: null };
  }
}

/**
 * The SecurityEvents recorder of one owner (docs/design/data/platform.md 13.3).
 * It writes through the security event model of the open unit (`auditTx`, the unit's internal
 * view of the reserved tables), so the market guard checks the row's Market and tenant like any
 * other write, and the unit's commit or rollback decides the row.
 */
class PrismaSecurityEvents implements SecurityEvents {
  constructor(
    private readonly owner: string,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async record(context: CallContext, event: unknown): Promise<void> {
    if (!isMinted(context)) throw new SecurityEventRefusedError('context-not-minted');
    const unit = unitStorage.getStore();
    if (unit === undefined || unit.closed) throw new SecurityEventRefusedError('no-open-unit');
    if (unit.readOnly) throw new SecurityEventRefusedError('read-only-unit');
    const market = context.market;
    if (
      !isMinted(market) ||
      market.marketId !== unit.market.marketId ||
      market.tenantId !== unit.market.tenantId
    ) {
      throw new SecurityEventRefusedError('market-mismatch');
    }
    if (!parseCorrelationId(context.correlationId).ok) {
      throw new SecurityEventRefusedError('correlation-id-invalid');
    }
    const row = this.rowOf(context, event);
    await auditTx(market).securityEvent.create({ data: row });
  }

  private rowOf(context: CallContext, event: unknown): SecurityEventRow {
    if (typeof event !== 'object' || event === null) {
      throw new SecurityEventRefusedError('event-invalid');
    }
    const { type, targetId, ip, payload } = event as Record<string, unknown>;
    if (typeof type !== 'string') throw new SecurityEventRefusedError('event-invalid');
    const definition = RECORDED_SECURITY_EVENTS.get(type);
    if (definition === undefined) {
      throw new SecurityEventRefusedError(
        type.startsWith(`${this.owner}.`) ? 'type-not-in-catalogue' : 'type-of-another-owner',
      );
    }
    if (definition.owner !== this.owner) {
      throw new SecurityEventRefusedError('type-of-another-owner');
    }

    let target: string | null = null;
    if (targetId !== null && targetId !== undefined) {
      if (definition.targetType === null) throw new SecurityEventRefusedError('target-undeclared');
      if (typeof targetId !== 'string' || !parseId(targetId).ok) {
        throw new SecurityEventRefusedError('target-id-invalid');
      }
      target = targetId;
    } else if (definition.targetRequired) {
      throw new SecurityEventRefusedError('target-missing');
    }

    let address: string | null = null;
    if (ip !== null && ip !== undefined) {
      if (!definition.ip) throw new SecurityEventRefusedError('ip-undeclared');
      // A zone id (`fe80::1%eth0`) passes isIP but not PostgreSQL's inet (Mojtaba on #514).
      if (typeof ip !== 'string' || ip.length > 45 || ip.includes('%') || isIP(ip) === 0) {
        throw new SecurityEventRefusedError('ip-invalid');
      }
      address = ip;
    }

    // Declared fields only, of the closed kinds (no free text); no permission key is declared.
    const encoded = encodePayload(definition.payload, payload, {
      isKnownPermissionKey: () => false,
    });
    if (!encoded.ok) throw new SecurityEventRefusedError('payload-invalid', encoded.error.field);
    const text = canonicalJson(encoded.value);
    if (!text.ok || Buffer.byteLength(text.value, 'utf8') > MAX_SECURITY_PAYLOAD_BYTES) {
      throw new SecurityEventRefusedError('payload-too-large');
    }

    return {
      id: this.ids.next<'SecurityEvent'>(),
      marketId: context.market.marketId,
      tenantId: context.market.tenantId,
      // Read inside the unit, cut to whole milliseconds (the database refuses anything finer).
      occurredAt: new Date(this.clock.now().epochMilliseconds),
      type: definition.type,
      severity: definition.severity,
      ...securityActorColumns(context.actor),
      targetType: target === null ? null : definition.targetType,
      targetId: target,
      ip: address,
      payload: encoded.value,
      correlationId: context.correlationId,
    };
  }
}

/** What {@link createSecurityEvents} needs; both come from the global platform providers. */
export interface SecurityEventsDependencies {
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * The recorder of one owner. Called only by `PersistenceModule.securityEventsFor`, which a
 * module's Nest module uses to bind its own `SECURITY_EVENTS`; there is no injectable factory.
 */
export function createSecurityEvents(
  owner: string,
  dependencies: SecurityEventsDependencies,
): SecurityEvents {
  return new PrismaSecurityEvents(owner, dependencies.ids, dependencies.clock);
}

/** The audit row fields a projection reads (the row the AuditWriter has just inserted). */
export interface ProjectedAuditRow {
  readonly id: string;
  readonly marketId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly actorType: 'USER' | 'SYSTEM' | 'ANONYMOUS';
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
}

/**
 * The security event of an audited action in {@link AUDITED_SECURITY_ACTIONS}, or null for any
 * other action: the audit row's instant, actor, target and correlation id, the catalogue's
 * severity, no address, and `{ auditLogId }` as its payload.
 */
export function projectionOf(row: ProjectedAuditRow, ids: IdGenerator): SecurityEventRow | null {
  const severity = AUDITED_SECURITY_ACTIONS.get(row.action);
  if (severity === undefined) return null;
  return {
    id: ids.next<'SecurityEvent'>(),
    marketId: row.marketId,
    tenantId: row.tenantId,
    occurredAt: row.occurredAt,
    type: row.action,
    severity,
    actorType: row.actorType,
    actorId: row.actorId,
    // The audit log's CHECKs on its target are the same as the security events' ones.
    targetType: row.targetType,
    targetId: row.targetId,
    ip: null,
    payload: { auditLogId: row.id },
    correlationId: row.correlationId,
  };
}
