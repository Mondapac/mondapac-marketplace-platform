import type { ApiFailure } from '../api/client.ts';

// The API's refusal codes in the seller's words (seller certificates design section 12; ux.md
// section 5). Keys are under `certification.error`; a code with no row reads as
// `identity.error.unknown`. The server's own message text is never shown.

export interface CertificateProblem {
  readonly key: string;
  /** What the page does next: reload the record (it changed), go back to the list (it is gone). */
  readonly then?: 'reload' | 'list';
  /** Field path (`issuerId`, `certificateNumber`, ...) to a message key. */
  readonly fields: Readonly<Record<string, string>>;
}

const CODE_KEYS: Readonly<Record<string, string>> = {
  'type.inactive': 'certification.error.type.inactive',
  'certificate.exists': 'certification.error.certificate.exists-for-type',
  'certificate.expired': 'certification.error.certificate.already-expired',
  'issuer.not-active': 'certification.error.issuer.not-active',
  'seller.zone-missing': 'certification.error.seller.zone-missing',
  'certificate.incomplete': 'certification.error.validation',
  'draft-quota.exceeded': 'certification.error.file.draft-quota',
  'document.limit-reached': 'certification.error.upload.limit',
  'file.too-large': 'certification.error.file.too-large',
  'file.unsupported-type': 'certification.error.file.type-not-allowed',
  'file.encrypted': 'certification.error.file.encrypted-pdf',
  'file.active-content': 'certification.error.file.active-content',
  'file.infected': 'certification.error.file.malware',
  'file.too-many-pages': 'certification.error.file.too-many-pages',
  'file.unreadable': 'certification.error.file.polyglot',
  'file.too-complex': 'certification.error.file.polyglot',
  'file.inspection-timeout': 'certification.error.file.polyglot',
  'file.scan-unavailable': 'certification.error.file.scan-failed',
  'type.no-issuer-registry': 'certification.error.type.no-issuer-registry',
  'issuer-request.already-open': 'certification.issuer-request.status.open',
  'request.throttled': 'certification.error.request.throttled',
  'access.acting-as-refused': 'certification.error.access.acting-as-refused',
  'access.denied': 'certification.error.access.denied',
  'request.csrf': 'identity.error.request.csrf',
};

/** The record changed under the page: it is read again and the seller sees its latest state. */
const STALE_CODES: ReadonlySet<string> = new Set([
  'certificate.not-editable',
  'certificate.not-submittable',
  'certificate.has-pending-submission',
  'certificate.no-pending-submission',
  'certificate.has-submissions',
  'conflict.stale',
  // The form does not offer "save and withdraw" yet (seller certificates PR 4), so a save that
  // would withdraw a pending submission reloads the record instead.
  'certificate.edit-withdraws-submission',
]);

const GONE_CODES: ReadonlySet<string> = new Set([
  'type.not-found',
  'certificate.not-found',
  'document.not-found',
]);

/** A field problem's code in words; the API's `details.fields[].code`. */
const FIELD_KEYS: Readonly<Record<string, string>> = {
  required: 'certification.form.error.required',
  'too-long': 'certification.form.error.too-long',
  'invalid-character': 'certification.form.error.invalid-character',
  format: 'certification.form.error.format',
  type: 'certification.form.error.format',
  'before-issue-date': 'certification.form.error.before-issue-date',
  // The chosen issuer is not one of this type's, or no longer takes certificates.
  unknown: 'certification.error.issuer.not-active',
  'not-selectable': 'certification.error.issuer.not-active',
  'not-applicable': 'certification.error.type.no-issuer-registry',
};

function fieldsOf(failure: ApiFailure): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const problem of [...(failure.details?.fields ?? []), ...(failure.details?.issues ?? [])]) {
    if (problem.path in fields) continue;
    fields[problem.path] = FIELD_KEYS[problem.code] ?? 'certification.form.error.invalid';
  }
  return fields;
}

export function certificateProblemOf(failure: ApiFailure): CertificateProblem {
  if (failure.code === 'validation.failed' || failure.code === 'certificate.incomplete') {
    return { key: 'certification.error.validation', fields: fieldsOf(failure) };
  }
  if (failure.code === 'request.throttled' && failure.details?.rule === 'daily') {
    return { key: 'certification.error.limit.daily', fields: {} };
  }
  if (STALE_CODES.has(failure.code)) {
    return { key: 'certification.error.stale', then: 'reload', fields: {} };
  }
  if (GONE_CODES.has(failure.code)) {
    return { key: 'certification.error.gone', then: 'list', fields: {} };
  }
  const key = CODE_KEYS[failure.code];
  if (key !== undefined) return { key, fields: {} };
  if (failure.status === 503 || failure.status === 0) {
    return { key: 'certification.error.unavailable', fields: {} };
  }
  return { key: 'identity.error.unknown', fields: {} };
}
