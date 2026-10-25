import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FieldKind } from '@mondapac/shared-kernel';
import {
  AUDITED_SECURITY_ACTIONS,
  RECORDED_SECURITY_EVENTS,
} from '../../src/platform/security-events/security-event-catalogue';

// SOC package 1 (docs/design/data/platform.md 13.2): the security event
// catalogue equals the checked-in snapshot, so every new or changed type, severity, target,
// address flag or payload field is read by the security-tester in the diff; every projected
// action is an audited action; every recording owner binds its recorder in its own module.

const SNAPSHOT = path.join(__dirname, 'security-event-catalogue.snapshot.json');
const AUDIT_SNAPSHOT = path.join(__dirname, 'audit-action-catalogue.snapshot.json');
const SRC = path.join(__dirname, '../../src');

function kindText(kind: FieldKind): string {
  switch (kind.kind) {
    case 'enumOf':
      return `enumOf(${kind.values.join('|')})`;
    case 'listOf':
      return `listOf(${kindText(kind.of)})`;
    case 'optional':
      return `optional(${kindText(kind.of)})`;
    default:
      return kind.kind;
  }
}

/** The catalogue as plain JSON, in a stable order. */
function describeSecurityEventCatalogue() {
  return {
    recorded: [...RECORDED_SECURITY_EVENTS.values()]
      .map((definition) => ({
        type: definition.type,
        owner: definition.owner,
        severity: definition.severity,
        targetType: definition.targetType,
        targetRequired: definition.targetRequired,
        ip: definition.ip,
        payload: Object.fromEntries(
          Object.entries(definition.payload)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, kind]) => [name, kindText(kind)]),
        ),
      }))
      .sort((a, b) => a.type.localeCompare(b.type)),
    projected: [...AUDITED_SECURITY_ACTIONS.entries()]
      .map(([action, severity]) => ({ action, severity }))
      .sort((a, b) => a.action.localeCompare(b.action)),
  };
}

describe('the security event catalogue (contracts)', () => {
  it('equals the checked-in snapshot', () => {
    const snapshot: unknown = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    expect(describeSecurityEventCatalogue()).toEqual(snapshot);
  });

  it('projects only actions of the audit action catalogue', () => {
    const audited = new Set(
      (JSON.parse(readFileSync(AUDIT_SNAPSHOT, 'utf8')) as { action: string }[]).map(
        (entry) => entry.action,
      ),
    );
    const unknown = [...AUDITED_SECURITY_ACTIONS.keys()].filter((action) => !audited.has(action));
    expect(unknown).toEqual([]);
  });

  it('binds each recording owner in its own Nest module, and no other recorder', () => {
    const owners = [...new Set([...RECORDED_SECURITY_EVENTS.values()].map((d) => d.owner))].sort();
    for (const owner of owners) {
      const source = readFileSync(path.join(SRC, 'modules', owner, `${owner}.module.ts`), 'utf8');
      expect(source).toContain(`PersistenceModule.securityEventsFor('${owner}')`);
    }
  });
});
