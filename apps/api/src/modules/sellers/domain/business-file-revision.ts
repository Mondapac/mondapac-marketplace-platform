import { canonicalJson, err, ok } from '@mondapac/shared-kernel';
import type { ContentHash, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { IdentifierIndexKey } from './business-identifier';
import {
  registerStateOf,
  type RegisterCheck,
  type RegisterMismatch,
  type RegisterOutcome,
} from './register-check';
import {
  REVISION_AUTHOR_KINDS,
  REVISION_KINDS,
  WITHDRAW_CAUSES,
  type RevisionAuthorKind,
  type RevisionKind,
  type WithdrawCause,
} from './revision-kinds';
import {
  missingParts,
  type DraftPart,
  type DraftRequirements,
  type SellerFileDraft,
} from './seller-file';

// The revisions of a seller's business file (sellers design 2.4, 3.1; data design 3.2; ADR-0009
// V1). This file holds the value types, the canonical content the hash is computed over, the
// submission check (completeness, ServiceArea, zones) and the status transitions. It knows no
// Market, no register and no country: everything Market-specific arrives as a parameter.

export {
  REVISION_AUTHOR_KINDS,
  REVISION_KINDS,
  WITHDRAW_CAUSES,
  type RevisionAuthorKind,
  type RevisionKind,
  type WithdrawCause,
};

/** V1's four statuses plus the module's own `withdrawn` (design 2.4 rule 1). */
export const REVISION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
  'superseded',
] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

/** The JSON shape of the content that new revisions are written with (data design 3.2). */
export const CONTENT_SCHEMA_VERSION = 1;

/** The register outcomes a submission can snapshot: `not-performed` is the absence of a row. */
export type RegisterSnapshotOutcome = RegisterOutcome | 'not-performed';

/**
 * The generic revision of the design (2.4), parameterised by what it holds. `content` never
 * changes once created. `contentHash` is an HMAC under the subject's key (ADR-0009 decision 6).
 */
export interface Revision<T> {
  readonly revisionNo: number;
  readonly content: T;
  readonly contentHash: ContentHash;
  readonly createdAt: Temporal.Instant;
  /** Null for the system actor. */
  readonly authorId: Id<'Account'> | null;
}

/**
 * What a reviewer sees of a revision: everything the draft held at submission (design 2.1). It is
 * personal data end to end: it leaves the module only as ciphertext under the seller's key and
 * never reaches a log, an event or an error. All keys are written, with `null` for "not given",
 * so the canonical bytes never depend on an absent key. Address objects hold the fields of the
 * Market's `address.format`, so another Market's fields need no new type.
 */
export interface BusinessFileContent {
  readonly schemaVersion: typeof CONTENT_SCHEMA_VERSION;
  readonly storeName: string;
  readonly businessName: string;
  readonly phone: string;
  readonly contactEmail: string | null;
  readonly address: Readonly<Record<string, string>>;
  /** Only when it differs from the operating address; null means "same". */
  readonly registeredAddress: Readonly<Record<string, string>> | null;
  readonly identifier: { readonly scheme: string; readonly value: string } | null;
  /** The tax registration answer at submission; null when none was recorded. */
  readonly registeredForIndirectTax: boolean | null;
}

const CONTENT_KEYS = [
  'schemaVersion',
  'storeName',
  'businessName',
  'phone',
  'contactEmail',
  'address',
  'registeredAddress',
  'identifier',
  'registeredForIndirectTax',
] as const;

export type ContentInvalid = { readonly code: 'revision-content.invalid' };

/**
 * The canonical bytes of the content: the RFC 8785 JSON, so keys are sorted, no space is
 * written and the same content gives the same bytes in every process (design 2.4 rule 2). This is
 * what is sealed and what the keyed hash covers. A content the encoding refuses (a lone
 * surrogate, an undefined member) is `revision-content.invalid`.
 */
export function canonicalContent(content: BusinessFileContent): Result<string, ContentInvalid> {
  if (content.schemaVersion !== CONTENT_SCHEMA_VERSION) {
    return err({ code: 'revision-content.invalid' });
  }
  const json = canonicalJson(content);
  return json.ok ? ok(json.value) : err({ code: 'revision-content.invalid' });
}

/** The canonical content as the bytes the HMAC covers (UTF-8). */
export function canonicalContentBytes(
  content: BusinessFileContent,
): Result<Uint8Array, ContentInvalid> {
  const json = canonicalContent(content);
  return json.ok ? ok(new TextEncoder().encode(json.value)) : json;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

/**
 * Reads the content back from the JSON that was sealed. Exact keys and types only: a stored
 * revision whose JSON has another shape is a fault of the data, never a value to use (the
 * caller fails closed). A later schema version needs a new reader, so another version is
 * refused here.
 */
export function parseContent(json: string): Result<BusinessFileContent, ContentInvalid> {
  const invalid = err({ code: 'revision-content.invalid' } as const);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return invalid;
  }
  if (!isRecord(raw)) return invalid;
  const keys = Object.keys(raw);
  if (
    keys.length !== CONTENT_KEYS.length ||
    !CONTENT_KEYS.every((key) => Object.hasOwn(raw, key))
  ) {
    return invalid;
  }
  const identifier = raw.identifier;
  const identifierOk =
    identifier === null ||
    (isRecord(identifier) &&
      Object.keys(identifier).length === 2 &&
      typeof identifier.scheme === 'string' &&
      typeof identifier.value === 'string');
  if (
    raw.schemaVersion !== CONTENT_SCHEMA_VERSION ||
    typeof raw.storeName !== 'string' ||
    typeof raw.businessName !== 'string' ||
    typeof raw.phone !== 'string' ||
    !(raw.contactEmail === null || typeof raw.contactEmail === 'string') ||
    !isStringMap(raw.address) ||
    !(raw.registeredAddress === null || isStringMap(raw.registeredAddress)) ||
    !identifierOk ||
    !(raw.registeredForIndirectTax === null || typeof raw.registeredForIndirectTax === 'boolean')
  ) {
    return invalid;
  }
  return ok(raw as unknown as BusinessFileContent);
}

/** The register check as the revision keeps it (data design 3.2: outcome, flags, instant). */
export interface RegisterSnapshot {
  readonly outcome: RegisterSnapshotOutcome;
  readonly mismatches: readonly RegisterMismatch[];
  readonly checkedAt: Temporal.Instant | null;
}

/**
 * The snapshot a submission writes (design 2.1, 3.4; Hassan M1 residual). A result the file may
 * not rely on is written as `not-performed`, with no instant and no flag, so approval needs a
 * manual check: no result, a stale one (aged, the draft changed, or the file is at another
 * version than the one compared) never becomes a clean `active`. `unavailable` and a definite
 * negative are kept as they are; the submit use case refuses a negative before it gets here.
 * `fileChangedAt` and `fileVersion` are those of the file the submit holds locked (or CASes by
 * version) in its own unit.
 */
export function registerSnapshotOf(
  check: RegisterCheck | null,
  now: Temporal.Instant,
  maxResultAgeDays: number,
  fileChangedAt: Temporal.Instant,
  fileVersion: number,
): RegisterSnapshot {
  const state = registerStateOf(check, now, maxResultAgeDays, fileChangedAt, fileVersion);
  if (check === null || state === 'not-performed' || state === 'stale') {
    return { outcome: 'not-performed', mismatches: [], checkedAt: null };
  }
  return {
    outcome: check.outcome,
    mismatches: state === 'active' ? check.mismatches : [],
    checkedAt: check.checkedAt,
  };
}

/** The zone and area columns of a revision, copied from the file at submission (data design 3.2). */
export interface SubmissionPlace {
  /** The zone the seller chose or accepted: clear, read with no key by `sellerSummaries`. */
  readonly operatingTimezone: string;
  /** The ServiceArea code of the operating address at its last save. */
  readonly serviceAreaCode: string;
  /**
   * The zone derived on the server from the operating address only, copied as the file holds it
   * (never recomputed here, never the chosen zone). Null is possible only for a revision that
   * was backfilled without decrypting an address; a submission always has one.
   */
  readonly addressTimezone: string | null;
}

/** What a complete draft gives the new revision besides its sealed content. */
export interface SubmissionSnapshot extends SubmissionPlace {
  /** The submitted identifier's keyed index, or null when the Market asks for none and none was given. */
  readonly identifierIndex: IdentifierIndexKey | null;
}

export type SubmissionRefused =
  | { readonly code: 'file.incomplete'; readonly missing: readonly DraftPart[] }
  | { readonly code: 'service-area.outside' };

/**
 * Whether a draft may be submitted, against the Market's current configuration (design 3.1, AC 5;
 * data design 3.1 `draft_complete` is only a hint, so this is recomputed): every mandatory part
 * (the identifier when `requirements.identifierRequired`, of the Market's current scheme), a zone
 * and an address, and an address in a ServiceArea whose `sellerOnboardingEnabled` is true
 * (`areaOnboardingEnabled`, resolved by the caller from the draft's `serviceAreaCode`; `null`
 * when the draft has no area or the Market no longer lists it). Fail closed: anything but a
 * definite `true` for the area refuses.
 */
export function evaluateSubmission(
  draft: SellerFileDraft,
  requirements: DraftRequirements,
  areaOnboardingEnabled: boolean | null,
): Result<SubmissionSnapshot, SubmissionRefused> {
  const missing = missingParts(draft, requirements);
  if (missing.length > 0) return err({ code: 'file.incomplete', missing });
  if (draft.serviceAreaCode === null || areaOnboardingEnabled !== true) {
    return err({ code: 'service-area.outside' });
  }
  if (draft.zone === null) {
    // Unreachable after missingParts, kept so the types and the data agree (fail closed).
    return err({ code: 'file.incomplete', missing: ['timezone'] });
  }
  const identifier = draft.identifier;
  return ok({
    operatingTimezone: draft.zone.operatingTimezone,
    serviceAreaCode: draft.serviceAreaCode,
    addressTimezone: draft.zone.addressTimezone,
    identifierIndex:
      identifier !== null && identifier.scheme === requirements.identifierScheme
        ? identifier.index
        : null,
  });
}

/** The stored form of a revision without its content (the content is sealed, data design 3.2). */
export interface BusinessFileRevision extends SubmissionSnapshot {
  readonly id: Id<'BusinessFileRevision'>;
  readonly sellerId: Id<'Seller'>;
  readonly kind: RevisionKind;
  readonly revisionNo: number;
  readonly status: RevisionStatus;
  readonly authorKind: RevisionAuthorKind;
  readonly authorAccountId: Id<'Account'>;
  readonly contentSchemaVersion: number;
  readonly contentHash: ContentHash;
  readonly register: RegisterSnapshot;
  readonly createdAt: Temporal.Instant;
  readonly statusChangedAt: Temporal.Instant;
  readonly decidedAt: Temporal.Instant | null;
  readonly decidedByAccountId: Id<'Account'> | null;
  readonly identityDecisionId: string | null;
  readonly rejectReasonCode: string | null;
  readonly withdrawal: {
    readonly cause: WithdrawCause;
    readonly byKind: RevisionAuthorKind;
    readonly at: Temporal.Instant;
  } | null;
}

/** The statuses a status may move to (design 3.1); a transition not listed is forbidden. */
const TRANSITIONS: Readonly<Record<RevisionStatus, readonly RevisionStatus[]>> = {
  pending: ['approved', 'rejected', 'withdrawn'],
  approved: ['superseded'],
  rejected: [],
  withdrawn: [],
  superseded: [],
};

export function canTransition(from: RevisionStatus, to: RevisionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type RevisionTransitionRefused = { readonly code: 'revision.transition-forbidden' };

export interface NewPendingRevisionInput {
  readonly id: Id<'BusinessFileRevision'>;
  readonly sellerId: Id<'Seller'>;
  readonly kind: RevisionKind;
  /** One more than the seller's highest revision number, or 1. */
  readonly revisionNo: number;
  readonly authorKind: RevisionAuthorKind;
  readonly authorAccountId: Id<'Account'>;
  readonly snapshot: SubmissionSnapshot;
  readonly contentHash: ContentHash;
  readonly register: RegisterSnapshot;
  readonly now: Temporal.Instant;
}

/**
 * A revision as a submission creates it: `pending`, its status instant equal to its creation
 * instant (data design 3.2), the register snapshot consistent with its CHECKs. Whatever the
 * entry point, a revision that would break a CHECK is refused here first (programmer error).
 */
export function newPendingRevision(input: NewPendingRevisionInput): BusinessFileRevision {
  if (!Number.isSafeInteger(input.revisionNo) || input.revisionNo < 1) {
    throw new RangeError('newPendingRevision: revision numbers start at 1');
  }
  if (!(REVISION_KINDS as readonly string[]).includes(input.kind)) {
    throw new TypeError('newPendingRevision: unknown kind');
  }
  if (!(REVISION_AUTHOR_KINDS as readonly string[]).includes(input.authorKind)) {
    throw new TypeError('newPendingRevision: unknown author kind');
  }
  const { register } = input;
  if ((register.outcome === 'not-performed') !== (register.checkedAt === null)) {
    throw new TypeError('newPendingRevision: a register instant exists exactly when one was made');
  }
  if (register.mismatches.length > 0 && register.outcome !== 'active') {
    throw new TypeError('newPendingRevision: mismatches only on an active outcome');
  }
  return {
    ...input.snapshot,
    id: input.id,
    sellerId: input.sellerId,
    kind: input.kind,
    revisionNo: input.revisionNo,
    status: 'pending',
    authorKind: input.authorKind,
    authorAccountId: input.authorAccountId,
    contentSchemaVersion: CONTENT_SCHEMA_VERSION,
    contentHash: input.contentHash,
    register,
    createdAt: input.now,
    statusChangedAt: input.now,
    decidedAt: null,
    decidedByAccountId: null,
    identityDecisionId: null,
    rejectReasonCode: null,
    withdrawal: null,
  };
}

/**
 * `pending` to `withdrawn` (design 3.1): the cause, who caused it and the instant are kept. The
 * use case that decides when to withdraw is slice 5b; the transition rule is here so no entry
 * point can withdraw anything but a pending revision.
 */
export function withdrawn(
  revision: BusinessFileRevision,
  cause: WithdrawCause,
  byKind: RevisionAuthorKind,
  now: Temporal.Instant,
): Result<BusinessFileRevision, RevisionTransitionRefused> {
  if (!canTransition(revision.status, 'withdrawn')) {
    return err({ code: 'revision.transition-forbidden' });
  }
  if (!(WITHDRAW_CAUSES as readonly string[]).includes(cause)) {
    throw new TypeError('withdrawn: unknown cause');
  }
  if (!(REVISION_AUTHOR_KINDS as readonly string[]).includes(byKind)) {
    throw new TypeError('withdrawn: unknown actor kind');
  }
  return ok({
    ...revision,
    status: 'withdrawn',
    statusChangedAt: now,
    withdrawal: { cause, byKind, at: now },
  });
}

/**
 * `approved` to `superseded` (design 3.1): another revision of the file was approved. A
 * superseded revision keeps the instant it was decided (data design 3.2 `decided_at`).
 */
export function superseded(
  revision: BusinessFileRevision,
  now: Temporal.Instant,
): Result<BusinessFileRevision, RevisionTransitionRefused> {
  if (!canTransition(revision.status, 'superseded') || revision.decidedAt === null) {
    return err({ code: 'revision.transition-forbidden' });
  }
  return ok({ ...revision, status: 'superseded', statusChangedAt: now });
}
