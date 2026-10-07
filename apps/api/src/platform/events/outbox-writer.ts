import type { Provider } from '@nestjs/common';
import type { CorrelationId, Id, MarketContext, PendingEvent } from '@mondapac/shared-kernel';

/**
 * What the outbox writer reads of the caller's context (platform persistence design, "P",
 * 5.1): the Market and the correlation id, never the aggregate's or the caller's data. It is
 * the part of the kernel's `CallContext` (identity slice 1c) the writer uses, so a
 * `CallContext` is passed to {@link OutboxWriter.append} unchanged once it exists.
 */
export interface EventContext {
  readonly market: MarketContext;
  readonly correlationId: CorrelationId;
}

/**
 * Writes the events of one module into its own outbox, in the open read-write unit of the
 * state change (P 5.2; ADR-0006 decision 2). The use case calls it inside `work`, after its
 * repository saved the aggregate.
 *
 * It stamps the event id (`IdGenerator`), the Market and tenant and the correlation id (the
 * context), and the causation id (`causedBy`, or `null`); see P 5.1. It throws, so that the
 * unit rolls back and an event is never dropped silently, when: no unit is open, or the unit is
 * read-only; the context's Market is not the unit's; a type is not this module's or not in the
 * event catalogue; an aggregate type, id or version (1 to 2^31 - 1) is malformed; the payload
 * does not match its definition.
 */
export interface OutboxWriter {
  append(context: EventContext, events: readonly PendingEvent[], causedBy?: Id): Promise<void>;
}

/** Binds an {@link OutboxWriter} to one module's outbox (P 5.2). */
export interface OutboxWriterFactory {
  forModule(module: string): OutboxWriter;
}

/** Nest token of the {@link OutboxWriterFactory}, provided by the persistence layer. */
export const OUTBOX_WRITER_FACTORY = Symbol('OUTBOX_WRITER_FACTORY');

/** Nest token of a module's own {@link OutboxWriter}; each module binds it with {@link outboxWriterFor}. */
export const OUTBOX_WRITER = Symbol('OUTBOX_WRITER');

/**
 * The one line of a module's Nest module that binds its writer (P 5.2):
 * `providers: [outboxWriterFor('identity')]`. The name is the module's folder; a test checks it.
 */
export function outboxWriterFor(module: string): Provider {
  return {
    provide: OUTBOX_WRITER,
    inject: [OUTBOX_WRITER_FACTORY],
    useFactory: (factory: OutboxWriterFactory) => factory.forModule(module),
  };
}

/** Why the outbox writer refused (P 5.2). Codes and, for a payload, the declared field name. */
export type OutboxRefusal =
  | 'read-only-unit'
  | 'correlation-id-invalid'
  | 'causation-id-invalid'
  | 'type-of-another-module'
  | 'type-not-in-catalogue'
  | 'aggregate-type-mismatch'
  | 'aggregate-id-invalid'
  | 'version-out-of-range'
  | 'occurred-at-invalid'
  | 'payload-invalid';

/**
 * The outbox writer refused an event or a call (P 5.2). It carries the reason and, for a
 * payload, the declared field name: never a value.
 */
export class OutboxWriteRefusedError extends Error {
  override readonly name = 'OutboxWriteRefusedError';
  constructor(
    readonly reason: OutboxRefusal,
    readonly field: string | null = null,
  ) {
    super(`The outbox writer refused: ${reason}${field === null ? '' : ` (${field})`}`);
  }
}

/**
 * Answers whether a permission key is known to the `PermissionRegistry` or its retired list
 * (foundations 6.1), for `permissionKey` payload fields (P 5.3). The registry arrives with
 * identity slice 8a; until then the binding knows no key, so such a field is refused.
 */
export interface PermissionKeyLookup {
  isKnownPermissionKey(key: string): boolean;
}

export const PERMISSION_KEY_LOOKUP = Symbol('PERMISSION_KEY_LOOKUP');

/** The binding before the permission registry exists: fail closed. */
export const NO_PERMISSION_KEYS: PermissionKeyLookup = Object.freeze({
  isKnownPermissionKey: () => false,
});
