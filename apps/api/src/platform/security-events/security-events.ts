import type { CallContext } from '@mondapac/shared-kernel';
import type { SecurityEventInput } from './security-event-catalogue';

/**
 * Records one security event into `platform.security_events`, inside the caller's open
 * read-write unit (docs/design/data/platform.md 13.3), the way the AuditWriter
 * writes an audit row. Bound per owner: a module reaches only its own recorder, through its
 * `SECURITY_EVENTS` token (`PersistenceModule.securityEventsFor('<module>')`), and may record
 * only the types of the catalogue it owns.
 *
 * - It uses the caller's unit and never opens one; it refuses when no unit is open, when the
 *   unit is read-only, or when the context's Market is not the unit's. A refused attempt that
 *   must still be recorded (a failed sign-in) commits its unit with an `ok` outcome, as the
 *   sign-in records do; a caller with no unit (a webhook refused before any work) opens a short
 *   unit for the event alone.
 * - The actor comes from the context; the id, Market, tenant, correlation id and instant from
 *   the context and the platform; the severity from the catalogue.
 * - The input must match its definition exactly: the declared target (an id), the address only
 *   on a type that declares it, and the declared payload fields (ids, codes, integers, booleans,
 *   instants; no free text, so no secret or email can be recorded).
 * - Every refusal throws {@link SecurityEventRefusedError}, so the unit rolls back.
 */
export interface SecurityEvents {
  record(context: CallContext, event: SecurityEventInput): Promise<void>;
}

/** Nest token of a module's own {@link SecurityEvents}; never exported by a module. */
export const SECURITY_EVENTS = Symbol('SECURITY_EVENTS');

/** The most canonical JSON a payload may hold, in UTF-8 bytes (the CHECK allows 4096). */
export const MAX_SECURITY_PAYLOAD_BYTES = 2048;

/** Why the recorder refused. Codes and, for a field, its declared name; never a value. */
export type SecurityEventRefusal =
  | 'context-not-minted'
  | 'no-open-unit'
  | 'read-only-unit'
  | 'market-mismatch'
  | 'correlation-id-invalid'
  | 'event-invalid'
  | 'type-not-in-catalogue'
  | 'type-of-another-owner'
  | 'target-missing'
  | 'target-undeclared'
  | 'target-id-invalid'
  | 'ip-undeclared'
  | 'ip-invalid'
  | 'payload-invalid'
  | 'payload-too-large';

export class SecurityEventRefusedError extends Error {
  override readonly name = 'SecurityEventRefusedError';
  constructor(
    readonly reason: SecurityEventRefusal,
    readonly field: string | null = null,
  ) {
    super(`The security event recorder refused: ${reason}${field === null ? '' : ` (${field})`}`);
  }
}
