import type { BadgeTone, IconName } from '@mondapac/ui';
import {
  CERTIFICATE_STATUSES,
  certificateEditPath,
  certificatePath,
  type CertificateStatus,
  type CertificateSummary,
} from './types.ts';

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

/** A draft's form is the certificate's own page (design 7); every other status has a status page. */
const DRAFT_STATUSES: ReadonlySet<string> = new Set(['draft', 'draft-issuer-not-listed']);

/** A certificate (or a renewal) sent back for changes: the form opens as a correction. */
const CORRECT_STATUSES: ReadonlySet<string> = new Set([
  'changes-needed',
  'approved-renewal-changes-needed',
]);

/**
 * A certificate with an approval and nothing pending: the form opens as a renewal. For an issuer
 * that is no longer recognised it is the replacement (a renewal-kind submission, ux.md 3.2).
 */
const RENEW_STATUSES: ReadonlySet<string> = new Set([
  'approved',
  'approved-expiring',
  'expired',
  'issuer-not-recognised',
]);

/**
 * How the form opens for a certificate (design 7.2), or null when it does not take changes:
 * `draft` and `correct` and `renew` save as usual; `pending` (a submission is under review) asks
 * first, because the first change withdraws the submission. The API's flags decide: `editable`
 * for a record with nothing pending, `withdrawable` for one under review.
 */
export type FormMode = 'draft' | 'correct' | 'renew' | 'pending';

export function formModeOf(certificate: CertificateSummary): FormMode | null {
  if (certificate.withdrawable) return 'pending';
  if (!certificate.editable) return null;
  if (DRAFT_STATUSES.has(certificate.status)) return 'draft';
  if (CORRECT_STATUSES.has(certificate.status)) return 'correct';
  if (RENEW_STATUSES.has(certificate.status)) return 'renew';
  return null;
}

/** The certificate's own page is its form (a draft), not its status page. */
export function isDraftStatus(status: string): boolean {
  return DRAFT_STATUSES.has(status);
}

/**
 * The form takes changes that withdraw nothing and the record can be submitted from it: a draft,
 * a correction or a renewal. The review page opens only for these.
 */
export function opensOnForm(certificate: CertificateSummary): boolean {
  const mode = formModeOf(certificate);
  return mode !== null && mode !== 'pending';
}

/** Where the form of a certificate is: the draft's own page, else its edit page. */
export function formPathOf(certificate: CertificateSummary): string {
  return isDraftStatus(certificate.status)
    ? certificatePath(certificate.certificateId)
    : certificateEditPath(certificate.certificateId);
}

/** The words of the form's main action and of the review page's Submit (ux.md section 5). */
export function submitKeyOf(certificate: CertificateSummary): string {
  switch (formModeOf(certificate)) {
    case 'correct':
      return 'certification.review.action.again';
    case 'renew':
      return 'certification.review.action.renew';
    default:
      return 'certification.review.action.submit';
  }
}

/** What a button of a certificate does: open its form, withdraw the submission, start a new one. */
export type CertificateActionKind = 'form' | 'withdraw' | 'add';

export interface CertificateAction {
  readonly id: string;
  readonly kind: CertificateActionKind;
  readonly labelKey: string;
  readonly primary: boolean;
}

/** The renewal's button: "Submit a replacement" for an issuer no longer recognised, else Renew. */
function renewAction(certificate: CertificateSummary): CertificateAction {
  return {
    id: 'renew',
    kind: 'form',
    labelKey:
      certificate.status === 'issuer-not-recognised'
        ? 'certification.issuer-not-recognised.action'
        : 'certification.action.renew',
    primary: true,
  };
}

/**
 * The buttons of the status page header (design sections 9 and 11), built from the API's flags
 * and the status, never guessed: a button shows only when the record allows what it does.
 * Declined and revoked offer a new certificate (they do not block one, design 6).
 */
export function statusActions(certificate: CertificateSummary): readonly CertificateAction[] {
  const mode = formModeOf(certificate);
  if (mode === 'pending') {
    return [
      { id: 'edit', kind: 'form', labelKey: 'certification.action.edit', primary: false },
      {
        id: 'withdraw',
        kind: 'withdraw',
        labelKey: 'certification.withdraw.action',
        primary: false,
      },
    ];
  }
  if (mode === 'draft') {
    return [
      { id: 'continue', kind: 'form', labelKey: 'certification.action.continue', primary: true },
    ];
  }
  if (mode === 'correct') {
    return [
      { id: 'correct', kind: 'form', labelKey: 'certification.changes.action', primary: true },
    ];
  }
  if (mode === 'renew') return [renewAction(certificate)];
  if (certificate.status === 'declined' || certificate.status === 'revoked') {
    return [{ id: 'add', kind: 'add', labelKey: 'certification.action.add', primary: true }];
  }
  return [];
}

/**
 * The one button of a list row (design section 11), as a message key, or null: the row's form
 * action (Continue, Correct and submit again, Renew, Submit a replacement). Withdrawing and adding
 * are on the status page and the header; the name link opens the certificate in every status.
 */
export function rowActionKey(certificate: CertificateSummary): string | null {
  const action = statusActions(certificate).find((item) => item.kind === 'form' && item.primary);
  return action?.labelKey ?? null;
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

/** The expiry banner tones, mildest first (design 5.1); the API sets which one applies. */
const BANNER_TONES = ['info', 'attention', 'critical'] as const;
export type ExpiryTone = (typeof BANNER_TONES)[number];

export function expiryToneOf(certificate: CertificateSummary): ExpiryTone | null {
  const tone = certificate.bannerTone;
  return (BANNER_TONES as readonly (string | null | undefined)[]).includes(tone)
    ? (tone as ExpiryTone)
    : null;
}

/**
 * The one expiry banner a page shows when several certificates qualify (design 5.1): the most
 * urgent, an expired one before one that expires, then the fewest days left.
 */
export function mostUrgentExpiry(rows: readonly CertificateSummary[]): CertificateSummary | null {
  let best: CertificateSummary | null = null;
  for (const row of rows) {
    if (expiryToneOf(row) === null) continue;
    if (best === null || urgencyOf(row) < urgencyOf(best)) best = row;
  }
  return best;
}

function urgencyOf(row: CertificateSummary): number {
  if (row.status === 'expired') return Number.MIN_SAFE_INTEGER + (row.daysLeft ?? 0);
  return row.daysLeft ?? Number.MAX_SAFE_INTEGER;
}

/**
 * What the dashboard's certificate card warns about (design 3): expired, expiring and sent back
 * for changes, the most urgent first; null when nothing needs the seller.
 */
const ALERT_ORDER: readonly string[] = [
  'expired',
  'issuer-not-recognised',
  'approved-expiring',
  'changes-needed',
  'approved-renewal-changes-needed',
];

export function dashboardAlertOf(rows: readonly CertificateSummary[]): CertificateSummary | null {
  for (const status of ALERT_ORDER) {
    const matching = rows.filter((row) => row.status === status);
    if (matching.length === 0) continue;
    if (status === 'approved-expiring') return mostUrgentExpiry(matching) ?? matching[0] ?? null;
    return matching[0] ?? null;
  }
  return null;
}

/** The next steps the panel has words for (`certification.next-step.<key>`). */
const NEXT_STEPS: ReadonlySet<string> = new Set([
  'upload-clearer-file',
  'upload-all-pages',
  'check-holder-name',
  'check-location-scope',
  'check-dates',
  'choose-issuer',
  'contact-support',
  'add-new-certificate',
]);

/**
 * The message key of a decision's next step (the API sends a key, the panel has the words), or
 * null for a key this panel does not know: the Market's reason words still show.
 */
export function nextStepKey(step: string): string | null {
  return NEXT_STEPS.has(step) ? `certification.next-step.${step}` : null;
}
