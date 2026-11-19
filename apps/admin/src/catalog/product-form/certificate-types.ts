import { dateFormat } from '../../shared/intl.ts';
import { pickLabel } from './draft-content.ts';
import type { FormField, ProductView } from './types.ts';

// The manufacturer certificates of one platform product (certification slice 14-15, ADR-0012):
// what the routes answer and the pure rules the card uses to word them. Instants are ISO 8601
// strings in UTC; dates are local dates (YYYY-MM-DD). The certificate number is never in an answer
// the card reads: it is encrypted and returned only on the reviewer's own read.

export const CERT_BASE = 'certification/admin/product-certificates';
export const CERT_VIEW_PERMISSION = 'certification.product-certificate.view';
export const CERT_EDIT_PERMISSION = 'certification.product-certificate.edit';
export const CERT_TYPE_VIEW_PERMISSION = 'certification.type.view';

/** The list stops here, so a full page is worth a caption. */
export const CERT_LIST_MAX = 100;
/** A certificate this close to its end shows "Expires in N days". */
export const EXPIRY_WARNING_DAYS = 30;

export type CertStatus =
  'draft' | 'in-review' | 'approved' | 'rejected' | 'suspended' | 'revoked' | 'expired';

export interface CertListItem {
  readonly id: string;
  readonly typeId: string;
  readonly typeCode: string;
  readonly typeName: string | null;
  /** Locales the Market publishes in for which the type has no name. */
  readonly typeNamesMissing: readonly string[];
  readonly status: CertStatus;
  readonly issuerName: string | null;
  readonly expiryDate: string | null;
  readonly coverage: { readonly whole: boolean; readonly variantIds: readonly string[] };
  readonly rejectionReasonCode: string | null;
  readonly lastChangedAt: string;
  readonly version: number;
}

/** `GET certification/admin/product-certificates/for-product/:productId`. */
export interface CertList {
  readonly items: readonly CertListItem[];
}

export interface CertOptionType {
  readonly typeId: string;
  readonly code: string;
  readonly name: string | null;
  readonly requiresDocument: boolean;
  readonly requiresExpiry: boolean;
  readonly issuers: readonly { readonly issuerId: string; readonly displayName: string }[];
}

/** `GET certification/admin/product-certificates/options`. */
export interface CertOptions {
  readonly types: readonly CertOptionType[];
}

interface CoverageEntry {
  readonly productId: string;
  readonly variantId: string | null;
}

interface CertDocument {
  readonly documentId: string;
  readonly mediaType: string;
  readonly byteSize: number;
}

interface CertRevision {
  readonly manufacturerName: string;
  readonly issuerId: string;
  readonly issueDate: string | null;
  readonly expiryDate: string | null;
  readonly coverage: readonly CoverageEntry[];
  readonly documents: readonly CertDocument[];
}

/** `GET certification/admin/product-certificates/:id` (no number: `certificateNumberSet` only). */
export interface CertRecord {
  readonly id: string;
  readonly typeId: string;
  readonly status: CertStatus;
  readonly version: number;
  readonly author: { readonly accountId: string };
  readonly draft: {
    readonly manufacturerName: string | null;
    readonly issuerId: string | null;
    readonly certificateNumberSet: boolean;
    readonly issueDate: string | null;
    readonly expiryDate: string | null;
    readonly coverage: readonly CoverageEntry[];
    readonly documents: readonly CertDocument[];
  };
  readonly pending: CertRevision | null;
  readonly approved: CertRevision | null;
}

export interface CertHistoryEntry {
  readonly id: string;
  readonly fromStatus: CertStatus | null;
  readonly toStatus: CertStatus;
  readonly actor: { readonly accountId: string } | null;
  readonly reasonCode: string | null;
  readonly occurredAt: string;
}

/** `GET certification/admin/product-certificates/:id/history`. */
export interface CertHistory {
  readonly entries: readonly CertHistoryEntry[];
}

export interface CertCreated {
  readonly certificateId: string;
  readonly version: number;
}

export interface CertVersioned {
  readonly version: number;
}

// ---- Status -------------------------------------------------------------------------------

export type CertBadgeTone = 'success' | 'info' | 'neutral' | 'attention' | 'critical';

export type CertStatusKind =
  'approved' | 'waiting' | 'draft' | 'expiring' | 'expired' | 'suspended' | 'rejected' | 'revoked';

export interface CertStatusView {
  readonly kind: CertStatusKind;
  readonly tone: CertBadgeTone;
  /** Whole days left, for `expiring`. */
  readonly days: number;
}

const DAY = 86_400_000;

/** The whole calendar days from `today` to a local date (YYYY-MM-DD); null when it is not a date. */
export function daysUntil(date: string | null, today: Date): number | null {
  if (date === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const end = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((end - start) / DAY);
}

/**
 * How a row shows its status. An approved certificate 30 days or fewer from its end reads
 * "Expires in N days" (Attention); one the nightly job has not yet marked expired but whose date
 * has passed reads Expired. Colour is never the only cue: every kind has its own words.
 */
export function statusOf(item: CertListItem, today: Date): CertStatusView {
  const days = daysUntil(item.expiryDate, today);
  const build = (kind: CertStatusKind, tone: CertBadgeTone, left = 0): CertStatusView => ({
    kind,
    tone,
    days: left,
  });
  switch (item.status) {
    case 'approved':
      if (days !== null && days < 0) return build('expired', 'attention');
      if (days !== null && days <= EXPIRY_WARNING_DAYS) return build('expiring', 'attention', days);
      return build('approved', 'success');
    case 'in-review':
      return build('waiting', 'info');
    case 'draft':
      return build('draft', 'neutral');
    case 'expired':
      return build('expired', 'attention');
    case 'suspended':
      return build('suspended', 'attention');
    case 'rejected':
      return build('rejected', 'critical');
    case 'revoked':
      return build('revoked', 'critical');
  }
}

/** A certificate that counts for the product today: approved and not past its date. */
export function isInForce(item: CertListItem, today: Date): boolean {
  if (item.status !== 'approved') return false;
  const days = daysUntil(item.expiryDate, today);
  return days === null || days >= 0;
}

// ---- Reasons ------------------------------------------------------------------------------

/**
 * The review reasons of the Market (`config/certification-review`) that have a sentence for an
 * admin reader. A code that is not here reads as the generic sentence; a code is never shown.
 */
export const REASON_CODES: readonly string[] = [
  'unreadable',
  'holder-name-mismatch',
  'location-scope-unclear',
  'issuer-unclear',
  'dates-unclear',
  'incomplete-file',
  'signs-of-tampering',
  'issuer-not-recognised',
  'not-confirmed-by-issuer',
  'declaration-not-accepted',
  'withdrawn-by-issuer',
  'approved-in-error',
  'under-investigation',
  'number-mismatch',
];

/** The message key (under `certs.reason`) for a reason code; unknown or missing: the generic one. */
export function reasonKey(code: string | null): string {
  return code !== null && REASON_CODES.includes(code) ? code : 'unknown';
}

// ---- Languages ----------------------------------------------------------------------------

/** "Persian and Arabic" from locale codes such as `fa-AU`, `ar-AU`; the language names are English. */
export function languageNames(locales: readonly string[]): string[] {
  const names = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const locale of locales) {
    const base = locale.split('-')[0] ?? locale;
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(names.of(base) ?? base);
  }
  return out;
}

// ---- Variants of the published revision ---------------------------------------------------

export interface PublishedVariant {
  readonly id: string;
  /** "White · 1 kg": the option names in the order of the variant types. */
  readonly label: string;
  /** The first variant type's option, to group by; empty for a product with one type. */
  readonly group: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The variants of the PUBLISHED revision, which are the only ones a certificate can name (the
 * form may hold unsaved ones). Read from the revision's own content, ordered like the variant
 * table: by the first variant type's option, then the next.
 */
export function publishedVariants(product: ProductView): PublishedVariant[] {
  const content = product.published?.content;
  const stored = content?.['variants'];
  const entries = Array.isArray(stored) ? stored.filter(isObject) : [];
  const axes: readonly FormField[] = product.form.fields.filter((field) => field.isVariantOption);
  const locale = product.locales.default;
  const rows = entries.flatMap((entry, index) => {
    const id = entry['variantId'];
    if (typeof id !== 'string') return [];
    const options = isObject(entry['optionValues']) ? entry['optionValues'] : {};
    const picked = axes.map((axis) => {
      const code = options[axis.code];
      const at = axis.options.findIndex((option) => option.code === code);
      const option = at < 0 ? undefined : axis.options[at];
      return option === undefined
        ? { text: null, at: Number.MAX_SAFE_INTEGER }
        : { text: pickLabel(option.labels, locale, option.code), at };
    });
    const parts = picked.map((item) => item.text).filter((text): text is string => text !== null);
    const labels = entry['labels'];
    const own =
      isObject(labels) && typeof labels[locale] === 'string' && labels[locale] !== ''
        ? labels[locale]
        : null;
    const label = parts.length > 0 ? parts.join(' · ') : (own ?? `Variant ${index + 1}`);
    return [
      {
        id,
        label,
        group: picked.length > 1 ? (picked[0]?.text ?? '') : '',
        order: picked.map((item) => item.at),
      },
    ];
  });
  rows.sort((a, b) => {
    for (let i = 0; i < Math.max(a.order.length, b.order.length); i += 1) {
      const diff = (a.order[i] ?? 0) - (b.order[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return rows.map(({ id, label, group }) => ({ id, label, group }));
}

/** The title of the published revision in the default language, else the first language it has. */
export function publishedTitle(product: ProductView): string {
  const texts = product.published?.content['texts'];
  if (!isObject(texts)) return '';
  const entry = texts[product.locales.default] ?? Object.values(texts)[0];
  return isObject(entry) && typeof entry['name'] === 'string' ? entry['name'] : '';
}

/** The first category of the published revision (else the working copy), named; null when none. */
export function categoryNameOf(product: ProductView): string | null {
  const content = product.published?.content ?? product.workingCopy?.content;
  const ids = content?.['categoryIds'];
  const first = Array.isArray(ids) ? ids.find((id): id is string => typeof id === 'string') : null;
  const category = product.form.categories.find((item) => item.categoryId === first);
  return category === undefined ? null : pickLabel(category.names, product.locales.default, '');
}

/** What a certificate's coverage of this product is, in the words of the table cell. */
export function coverageCount(
  item: Pick<CertListItem, 'coverage'>,
  variants: readonly PublishedVariant[],
):
  | { readonly kind: 'whole' }
  | { readonly kind: 'some'; readonly count: number; readonly of: number } {
  if (item.coverage.whole) return { kind: 'whole' };
  const known = new Set(variants.map((variant) => variant.id));
  const count = item.coverage.variantIds.filter((id) => known.has(id)).length;
  return {
    kind: 'some',
    count: count === 0 ? item.coverage.variantIds.length : count,
    of: variants.length,
  };
}

/** A file size as a person reads it: "412 KB", "1.2 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_TYPES: readonly string[] = ['application/pdf', 'image/jpeg', 'image/png'];

export function mediaLabel(mediaType: string): string {
  if (mediaType === 'application/pdf') return 'PDF';
  if (mediaType === 'image/jpeg') return 'JPEG';
  if (mediaType === 'image/png') return 'PNG';
  return 'File';
}

/** A local date (YYYY-MM-DD) as "30 Jun 2027" ("30 Jun" when `year` is false); a bad value shows a dash. */
export function formatDay(date: string | null, locale: string, year = true): string {
  const match = date === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return '-';
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return dateFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(at);
}

/** "Persian and Arabic" / "Persian or Arabic". */
export function joinWords(words: readonly string[], type: 'conjunction' | 'disjunction'): string {
  return new Intl.ListFormat('en', { style: 'long', type }).format(words);
}
