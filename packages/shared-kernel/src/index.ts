// Shared kernel (ADR-0008 decision 1, ADR-0020 decision 2): framework-free building blocks
// shared by api and web. No I/O, no Node API, no framework; `domain/` code may import
// nothing else.
//
// Slice 0 (platform-foundations design, section 3): Result, Id, Clock and Temporal,
// MarketContext with minting, CorrelationId. Slice 1b (platform persistence design 5):
// DomainEvent, PendingEvent, defineEvent and the payload field kinds. Slice 1c (identity design
// 4, foundations 3.4 and 5.2): the ActorContext and CallContext types and ContextMismatchError;
// their constructors are on the `/contexts` entry, for the platform's entry adapters only.
// Identity slice 6a (platform-audit design 3 and 6.3): ContentHash, canonicalJson (RFC 8785)
// and defineAuditAction with the audit field vocabulary.
// Money has its own trigger (ADR-0015).
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

export { POPULATIONS } from './actor-context';
export type {
  ActorContext,
  AnonymousActor,
  AuthenticatedActor,
  Population,
  SystemActor,
} from './actor-context';

export { ContextMismatchError } from './call-context';
export type { CallContext, ContextMismatchReason } from './call-context';

export {
  checkAggregateVersion,
  defineEvent,
  describeEventDefinition,
  encodePayload,
  eventField,
  MAX_AGGREGATE_VERSION,
} from './domain-event';
export type {
  BooleanKind,
  DomainEvent,
  EnumKind,
  EventDefinition,
  EventDescription,
  EventPayloadError,
  FieldKind,
  FieldValue,
  IdKind,
  InstantKind,
  IntegerKind,
  JsonObject,
  JsonValue,
  ListKind,
  OptionalKind,
  PayloadCheckOptions,
  PayloadFields,
  PayloadOf,
  PendingEvent,
  PermissionKeyKind,
  RecordInput,
} from './domain-event';

export { canonicalJson, MAX_CANONICAL_JSON_DEPTH } from './canonical-json';
export type { CanonicalJsonError } from './canonical-json';

export { CONTENT_HASH_PATTERN, parseContentHash } from './content-hash';
export type { ContentHash, ContentHashError } from './content-hash';

export {
  AUDIT_ACTOR_KINDS,
  auditField,
  BOUND_SUBJECT_FIELD,
  defineAuditAction,
  describeAuditAction,
  encodeAuditFields,
  isAuditActionDefinition,
  MAX_AUDIT_LIST_LENGTH,
} from './audit-action';
export type {
  AuditActionDefinition,
  AuditActionDescription,
  AuditActorKind,
  AuditEntry,
  AuditEntryValues,
  AuditFieldCheckOptions,
  AuditFieldKind,
  AuditFields,
  AuditFieldsError,
  AuditFieldValue,
  AuditListKind,
  AuditOptionalKind,
  AuditPlainKind,
  AuditTargetValue,
  AuditValuesOf,
} from './audit-action';

export { parsePlainText } from './plain-text';
export type { InvisibleCharacterKind, PlainText, PlainTextError } from './plain-text';

export {
  ATTRIBUTE_DATA_TYPES,
  ATTRIBUTE_ISSUE_CODES,
  validateAttributeValues,
} from './attribute-schema';
export type {
  AttributeDataType,
  AttributeField,
  AttributeIssue,
  AttributeIssueCode,
  AttributeSchema,
  AttributeSchemaRef,
  AttributeValue,
  AttributeValues,
  Locale,
  OptionRef,
  ValidationResult,
} from './attribute-schema';
