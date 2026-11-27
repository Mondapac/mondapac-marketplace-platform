import type { BadgeTone, IconName } from '@mondapac/ui';
import { CERTIFICATE_STATUSES, type CertificateStatus, type CertificateSummary } from './types.ts';

// How each seller-visible status shows (seller certificates design section 11; ux.md 3.2): a
// badge is always an icon and a word, never colour alone. The words are
// `certification.status.<code>`.

interface StatusLook {
  readonly tone: BadgeTone;
  readonly icon: IconName;
}

const LOOK: Readonly<Record<CertificateStatus, StatusLook>> = {
  draft: { tone: 'neutral', icon: 'file' },
  'draft-issuer-not-listed': { tone: 'info', icon: 'clock' },
  'awaiting-review': { tone: 'info', icon: 'clock' },
  'changes-needed': { tone: 'attention', icon: 'alert-triangle' },
  declined: { tone: 'critical', icon: 'x' },
  approved: { tone: 'success', icon: 'check' },
  'approved-expiring': { tone: 'attention', icon: 'clock' },
  'approved-renewal-pending': { tone: 'info', icon: 'clock' },
  'approved-renewal-changes-needed': { tone: 'attention', icon: 'alert-triangle' },
  expired: { tone: 'critical', icon: 'ban' },
  'expired-renewal-pending': { tone: 'info', icon: 'clock' },
  revoked: { tone: 'critical', icon: 'ban' },
  'issuer-not-recognised': { tone: 'critical', icon: 'alert-triangle' },
};

const UNKNOWN_LOOK: StatusLook = { tone: 'neutral', icon: 'info' };

export function isKnownStatus(status: string): status is CertificateStatus {
  return (CERTIFICATE_STATUSES as readonly string[]).includes(status);
}

/** The badge of a status; a code this panel has no words for shows as "Unknown status". */
export function statusLook(status: string): StatusLook & { readonly labelKey: string } {
  return isKnownStatus(status)
    ? { ...LOOK[status], labelKey: `certification.status.${status}` }
    : { ...UNKNOWN_LOOK, labelKey: 'certification.status.unknown' };
}

/**
 * The statuses whose details the seller fills in on the form: a draft, and a certificate (or a
 * renewal) sent back for changes. Saving one of these never withdraws a submission.
 */
const FORM_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'draft-issuer-not-listed',
  'changes-needed',
  'approved-renewal-changes-needed',
]);

/** The form takes changes: the API says the record is editable and nothing is under review. */
export function opensOnForm(certificate: CertificateSummary): boolean {
  return certificate.editable && FORM_STATUSES.has(certificate.status);
}

/**
 * The one button of a list row (design section 11), as a message key, or null. Only the actions
 * this panel has built are offered; the name link opens the certificate in every status.
 */
export function rowActionKey(certificate: CertificateSummary): string | null {
  if (!opensOnForm(certificate)) return null;
  return certificate.status === 'draft' || certificate.status === 'draft-issuer-not-listed'
    ? 'certification.action.continue'
    : 'certification.changes.action';
}

/** What needs the seller's work comes first (design section 5): expired, expiring, changes. */
const URGENCY: Readonly<Record<string, number>> = {
  expired: 0,
  'issuer-not-recognised': 1,
  'approved-expiring': 2,
  'changes-needed': 3,
  'approved-renewal-changes-needed': 3,
};

/** The list order: the rows that need work first, then the rest by last change, newest first. */
export function sortForList(rows: readonly CertificateSummary[]): readonly CertificateSummary[] {
  return [...rows].sort((a, b) => {
    const urgency = (URGENCY[a.status] ?? 9) - (URGENCY[b.status] ?? 9);
    if (urgency !== 0) return urgency;
    return b.lastChangedAt.localeCompare(a.lastChangedAt);
  });
}

/**
 * A certificate that keeps a new one of its type from being started (design section 6): any
 * open record. A declined or revoked one does not.
 */
export function blocksNewOfType(certificate: CertificateSummary): boolean {
  return certificate.status !== 'declined' && certificate.status !== 'revoked';
}
