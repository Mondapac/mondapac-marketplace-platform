import { err, ok, parsePlainText, Temporal } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { IssuerState, SellerCertificationStatus } from './validity';

// The seller side of a certificate (certification design 2.1, 3.1 to 3.3): the draft a seller
// edits, what makes it complete for a type, the kind of a submission and the status code the
// seller sees. Pure: time comes in as an argument from the Clock.

export const MAX_DOCUMENTS_PER_CERTIFICATE = 10;
export const MAX_CERTIFICATE_NUMBER_LENGTH = 64;
export const MAX_SELF_DECLARATION_NOTE_LENGTH = 1000;
/** The first warning threshold of the seller's status (design 3.3; Market configuration later). */
export const EXPIRING_WITHIN_DAYS = 30;
/** The content schema version of a submission (data design 3.5). */
export const SUBMISSION_CONTENT_SCHEMA_VERSION = 1;

export type SubmissionKind = 'initial' | 'resubmission' | 'renewal';

/** The settings of the published type revision that a draft is checked against. */
export interface TypeSettings {
  readonly typeId: Id<'CertificationType'>;
  readonly code: string;
  readonly status: 'active' | 'inactive';
  readonly revisionId: Id<'CertificationTypeRevision'>;
  readonly verificationMode: 'THIRD_PARTY_DOCUMENT' | 'SELF_DECLARATION';
  readonly requiresIssuerRegistry: boolean;
  readonly requiresDocument: boolean;
  readonly requiresExpiry: boolean;
}

/** The seller's working copy, in clear. The number and the note are ciphertext in the store. */
export interface DraftContent {
  readonly issuerId: Id<'Issuer'> | null;
  readonly certificateNumber: string | null;
  readonly issueDate: Temporal.PlainDate | null;
  readonly expiryDate: Temporal.PlainDate | null;
  readonly selfDeclared: boolean | null;
  readonly selfDeclarationNote: string | null;
}

export interface DraftField {
  readonly path: string;
  readonly code: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

function parseDate(value: unknown, path: string, fields: DraftField[]): Temporal.PlainDate | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !DATE.test(value)) {
    fields.push({ path, code: 'format' });
    return null;
  }
  try {
    const date = Temporal.PlainDate.from(value, { overflow: 'reject' });
    if (date.year < MIN_YEAR || date.year > MAX_YEAR) throw new RangeError('year');
    return date;
  } catch {
    fields.push({ path, code: 'format' });
    return null;
  }
}

function parseText(value: unknown, path: string, max: number, fields: DraftField[]): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    fields.push({ path, code: 'type' });
    return null;
  }
  const text = value.trim();
  if (text.length === 0) return null;
  if (Array.from(text).length > max) {
    fields.push({ path, code: 'too-long' });
    return null;
  }
  if (!parsePlainText(text).ok) {
    fields.push({ path, code: 'invalid-character' });
    return null;
  }
  return text;
}

/**
 * The draft a seller sends: every field present, `null` clears it. Dates are local dates
 * (`YYYY-MM-DD`, ADR-0005); the number and the note are plain text of bounded length. Nothing is
 * checked against a type here (that is the submit), only the shape and the date order.
 */
export function parseDraftContent(input: unknown): Result<DraftContent, readonly DraftField[]> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err([{ path: 'body', code: 'type' }]);
  }
  const record = input as Record<string, unknown>;
  const fields: DraftField[] = [];
  let issuerId: Id<'Issuer'> | null = null;
  const rawIssuer = record['issuerId'];
  if (rawIssuer !== null) {
    if (typeof rawIssuer === 'string' && UUID.test(rawIssuer)) issuerId = rawIssuer as Id<'Issuer'>;
    else fields.push({ path: 'issuerId', code: 'format' });
  }
  const certificateNumber = parseText(
    record['certificateNumber'],
    'certificateNumber',
    MAX_CERTIFICATE_NUMBER_LENGTH,
    fields,
  );
  const issueDate = parseDate(record['issueDate'], 'issueDate', fields);
  const expiryDate = parseDate(record['expiryDate'], 'expiryDate', fields);
  if (
    issueDate !== null &&
    expiryDate !== null &&
    Temporal.PlainDate.compare(issueDate, expiryDate) > 0
  ) {
    fields.push({ path: 'expiryDate', code: 'before-issue-date' });
  }
  let selfDeclared: boolean | null = null;
  const rawTick = record['selfDeclared'];
  if (rawTick !== null) {
    if (typeof rawTick === 'boolean') selfDeclared = rawTick;
    else fields.push({ path: 'selfDeclared', code: 'type' });
  }
  const selfDeclarationNote = parseText(
    record['selfDeclarationNote'],
    'selfDeclarationNote',
    MAX_SELF_DECLARATION_NOTE_LENGTH,
    fields,
  );
  if (fields.length > 0) return err(fields);
  return ok({
    issuerId,
    certificateNumber,
    issueDate,
    expiryDate,
    selfDeclared,
    selfDeclarationNote,
  });
}

/** True while the seller may edit the draft: no submission is pending and the record is open. */
export function isDraftEditable(
  status: SellerCertificationStatus,
  pendingSubmissionId: string | null,
): boolean {
  if (pendingSubmissionId !== null) return false;
  return (
    status === 'draft' ||
    status === 'changes-needed' ||
    status === 'approved' ||
    status === 'expired'
  );
}

/**
 * What an edit of the draft (fields or files) may do (design 3.2 row 2, slice 8). `edit`: the
 * draft is open. `confirm-withdraw`: a submission is pending and the seller has not yet confirmed
 * that the edit withdraws it (the panel's "Save and withdraw" dialog). `withdraw-then-edit`: the
 * seller confirmed; the pending submission is withdrawn (cause `edited`) in the unit that writes
 * the edit. `closed`: nothing can change (declined, revoked, or a state no transition allows).
 */
export type DraftEditVerdict = 'edit' | 'confirm-withdraw' | 'withdraw-then-edit' | 'closed';

export function draftEditVerdict(
  status: SellerCertificationStatus,
  pendingSubmissionId: string | null,
  withdrawConfirmed: boolean,
): DraftEditVerdict {
  if (pendingSubmissionId === null) return isDraftEditable(status, null) ? 'edit' : 'closed';
  // A pending submission exists only on `in-review` (first review or correction) and on an
  // `approved` or `expired` record (renewal, design 3.1).
  if (status !== 'in-review' && status !== 'approved' && status !== 'expired') return 'closed';
  return withdrawConfirmed ? 'withdraw-then-edit' : 'confirm-withdraw';
}

/**
 * The record's status after its pending submission is withdrawn by the seller (design 3.1): a
 * record that was never approved goes back to `draft`; an approved or expired one keeps its status
 * and its approved submission, untouched. A record with an approval is never left `in-review`
 * (Hassan I2): should one be found there, it goes to `approved`. That grants nothing by itself:
 * validity still needs the approved submission's boundary after now and an issuer that is not
 * derecognised (2.4 rule 1), so past the boundary the answer stays "not valid".
 */
export function statusAfterWithdraw(
  status: SellerCertificationStatus,
  hasApproval: boolean,
): SellerCertificationStatus {
  if (status !== 'in-review') return status;
  return hasApproval ? 'approved' : 'draft';
}

const sameDate = (a: Temporal.PlainDate | null, b: Temporal.PlainDate | null): boolean =>
  a === null || b === null ? a === b : a.equals(b);

/** True when two drafts hold the same values; an unchanged save withdraws nothing (ux FL3). */
export function sameDraftContent(a: DraftContent, b: DraftContent): boolean {
  return (
    a.issuerId === b.issuerId &&
    a.certificateNumber === b.certificateNumber &&
    sameDate(a.issueDate, b.issueDate) &&
    sameDate(a.expiryDate, b.expiryDate) &&
    a.selfDeclared === b.selfDeclared &&
    a.selfDeclarationNote === b.selfDeclarationNote
  );
}

/**
 * The kind of the next submission (design 3.2 row 1): `renewal` when the record was approved at
 * some point and is `approved` or `expired`, `resubmission` after `changes-requested`, else
 * `initial`. `null` when the record cannot be submitted (pending, declined, revoked).
 */
export function submissionKindFor(
  status: SellerCertificationStatus,
  pendingSubmissionId: string | null,
): SubmissionKind | null {
  if (pendingSubmissionId !== null) return null;
  switch (status) {
    case 'draft':
      return 'initial';
    case 'changes-needed':
      return 'resubmission';
    case 'approved':
    case 'expired':
      return 'renewal';
    default:
      return null;
  }
}

/**
 * What is missing from the draft for the type revision in force (design 3.2 row 1). The codes are
 * field paths with a reason; the issuer's state and the expiry boundary are checked apart.
 */
export function incompleteFields(
  settings: TypeSettings,
  draft: DraftContent,
  documentCount: number,
): readonly DraftField[] {
  const missing: DraftField[] = [];
  if (settings.verificationMode === 'SELF_DECLARATION') {
    if (draft.selfDeclared !== true) missing.push({ path: 'selfDeclared', code: 'required' });
  } else {
    if (settings.requiresIssuerRegistry && draft.issuerId === null) {
      missing.push({ path: 'issuerId', code: 'required' });
    }
    if (draft.certificateNumber === null) {
      missing.push({ path: 'certificateNumber', code: 'required' });
    }
  }
  if (settings.requiresExpiry && draft.expiryDate === null) {
    missing.push({ path: 'expiryDate', code: 'required' });
  }
  if (settings.requiresDocument && documentCount < 1) {
    missing.push({ path: 'documents', code: 'required' });
  }
  return missing;
}

/** The content a submission keeps, by mode: a self-declaration holds no issuer and no number. */
export function submissionContentOf(settings: TypeSettings, draft: DraftContent): DraftContent {
  if (settings.verificationMode === 'SELF_DECLARATION') {
    return {
      issuerId: null,
      certificateNumber: null,
      issueDate: draft.issueDate,
      expiryDate: settings.requiresExpiry ? draft.expiryDate : null,
      selfDeclared: draft.selfDeclared,
      selfDeclarationNote: draft.selfDeclarationNote,
    };
  }
  return {
    issuerId: settings.requiresIssuerRegistry ? draft.issuerId : null,
    certificateNumber: draft.certificateNumber,
    issueDate: draft.issueDate,
    expiryDate: settings.requiresExpiry ? draft.expiryDate : null,
    selfDeclared: null,
    selfDeclarationNote: null,
  };
}

/**
 * The expiry boundary the submit guard compares with now: 00:00 on the day after the expiry date
 * in `zone` (design 2.4 rule 2). A seller zone that Temporal cannot resolve throws, and the
 * caller treats that as "no zone".
 */
export function expiryBoundaryIn(expiryDate: Temporal.PlainDate, zone: string): Temporal.Instant {
  return expiryDate.add({ days: 1 }).toZonedDateTime(zone).toInstant();
}

/** The status codes the seller sees (design 3.3). */
export type SellerStatusCode =
  | 'draft'
  | 'draft-issuer-not-listed'
  | 'awaiting-review'
  | 'changes-needed'
  | 'declined'
  | 'approved'
  | 'approved-expiring'
  | 'approved-renewal-pending'
  | 'approved-renewal-changes-needed'
  | 'expired'
  | 'expired-renewal-pending'
  | 'revoked'
  | 'issuer-not-recognised';

export interface SellerStatusInput {
  readonly status: SellerCertificationStatus;
  /** The kind of the pending submission, or null. */
  readonly pendingKind: SubmissionKind | null;
  /** The boundary stored at approval; null without an approval or without an expiry. */
  readonly approvedBoundaryAt: Temporal.Instant | null;
  readonly hasApproval: boolean;
  readonly approvedIssuerState: IssuerState | null;
  /** True while the seller has an open "my issuer is not listed" request for this type. */
  readonly issuerRequestOpen: boolean;
  /**
   * The decision on the newest submission, or null when it is pending or there is none. With an
   * approval, `changes-requested` here means the renewal (or correction) after it was sent back.
   */
  readonly latestOutcome: SubmissionOutcome | null;
}

/** A decision on a submission (data design 3.6): one terminal row per submission. */
export type SubmissionOutcome = 'approved' | 'changes-requested' | 'declined' | 'withdrawn';

export interface SellerStatus {
  readonly code: SellerStatusCode;
  /**
   * The instant the approved certificate stops counting, for `approved-expiring` (submit the
   * renewal before it) and `approved-renewal-changes-needed` ("valid until {date} only").
   */
  readonly submitBy: Temporal.Instant | null;
}

/**
 * The status code from the record, the pending submission and the stored boundary at `now`
 * (design 3.3). Past the boundary the answer is "expired" whether or not the job ran (design 2.4
 * rule 4). This is a display; the claim is decided by `evaluateClaims`, never from here.
 */
export function sellerStatusOf(input: SellerStatusInput, now: Temporal.Instant): SellerStatus {
  const none = null;
  const { status, pendingKind } = input;
  if (status === 'declined') return { code: 'declined', submitBy: none };
  if (status === 'revoked') return { code: 'revoked', submitBy: none };
  if (status === 'changes-needed') return { code: 'changes-needed', submitBy: none };
  if (status === 'draft') {
    return { code: input.issuerRequestOpen ? 'draft-issuer-not-listed' : 'draft', submitBy: none };
  }
  // `in-review` is the first review of a record that was never approved; a renewal of an approved
  // record leaves the record `approved` or `expired` with a pending pointer (design 3.1).
  if (status === 'in-review' || !input.hasApproval) {
    return { code: 'awaiting-review', submitBy: none };
  }

  const boundary = input.approvedBoundaryAt;
  const pastBoundary = boundary !== null && Temporal.Instant.compare(boundary, now) <= 0;
  if (status === 'expired' || pastBoundary) {
    return {
      code: pendingKind === null ? 'expired' : 'expired-renewal-pending',
      submitBy: none,
    };
  }
  if (input.approvedIssuerState === 'derecognised') {
    return { code: 'issuer-not-recognised', submitBy: none };
  }
  if (pendingKind !== null) return { code: 'approved-renewal-pending', submitBy: none };
  // The newest submission came after the approved one and was sent back (ux FL4 row 4).
  if (input.latestOutcome === 'changes-requested') {
    return { code: 'approved-renewal-changes-needed', submitBy: boundary };
  }
  if (boundary !== null) {
    const warnFrom = boundary.subtract({ hours: EXPIRING_WITHIN_DAYS * 24 });
    if (Temporal.Instant.compare(now, warnFrom) >= 0) {
      return { code: 'approved-expiring', submitBy: boundary };
    }
  }
  return { code: 'approved', submitBy: none };
}
