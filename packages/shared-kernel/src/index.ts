// Shared kernel (ADR-0008 decision 1, ADR-0020 decision 2): framework-free building blocks
// shared by api and web. No I/O, no Node API, no framework; `domain/` code may import
// nothing else.
//
// Slice 0 (platform-foundations design, section 3): Result, Id, Clock and Temporal,
// MarketContext with minting, CorrelationId. Slice 1b (platform persistence design 5):
// DomainEvent, PendingEvent, defineEvent and the payload field kinds. ActorContext and
// CallContext arrive in slice 1c; Money has its own trigger (ADR-0015).
//
// Named exports only. Fakes and test builders live on the `/testing` entry and are never
// re-exported from here.
export { err, ok } from './result';
export type { Result } from './result';

export { parseId, uuidV7 } from './id';
export type { Id, IdGenerator } from './id';

export { Temporal } from './time';
export type { Clock } from './time';

export { mintMarketContext, parseMarketId, parseTenantId } from './market-context';
export type { MarketContext, MarketId, TenantId } from './market-context';

export { parseCorrelationId } from './correlation-id';
export type { CorrelationId } from './correlation-id';

export { isMinted } from './minted';

export {
  checkAggregateVersion,
  defineEvent,
  describeEventDefinition,
  encodePayload,
  eventField,
  MAX_AGGREGATE_VERSION,
} from './domain-event';
export type {
  DomainEvent,
  EventDefinition,
  EventDescription,
  EventPayloadError,
  FieldKind,
  FieldValue,
  JsonObject,
  JsonValue,
  PayloadCheckOptions,
  PayloadFields,
  PayloadOf,
  PendingEvent,
  RecordInput,
} from './domain-event';
