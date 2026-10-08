import { err, ok, type Result } from '@mondapac/shared-kernel';
import { normaliseClaimText } from './claim-text-matcher';
import type { CertificationTypeCode } from './claim-types';

export const VERIFICATION_MODES = ['THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/** A type's default is never `SELLER_OR_MANUFACTURER` (brief s5, AC 4). */
export type TypeDefaultBasis = 'SELLER_REQUIRED' | 'NOT_APPLICABLE';

export interface TypeLocaleContent {
  readonly name: string;
  readonly customerDescription: string;
  /** Written by people (R10); each a phrase of one or more tokens. */
  readonly claimTerms: readonly string[];
}

/** The content of one type revision (design 2.1). A revision is never edited. */
export interface TypeRevisionContent {
  readonly verificationMode: VerificationMode;
  readonly requiresIssuerRegistry: boolean;
  readonly requiresDocument: boolean;
  readonly requiresExpiry: boolean;
  readonly defaultBasis: TypeDefaultBasis;
  readonly autoApproveSelfDeclaration: boolean;
  /** A key of the design system's icon set (ADR-0017); never an uploaded file. */
  readonly badgeIconKey: string;
  readonly locales: Readonly<Record<string, TypeLocaleContent>>;
}

export type TypeRevisionProblem =
  | { readonly code: 'type.code-invalid' }
  | { readonly code: 'type.verification-mode-invalid' }
  | { readonly code: 'type.default-basis-invalid' }
  | { readonly code: 'type.auto-approve-needs-self-declaration' }
  | { readonly code: 'type.locale-not-supported'; readonly locale: string }
  | { readonly code: 'type.locale-missing'; readonly locale: string }
  | { readonly code: 'type.text-invalid'; readonly locale: string }
  | { readonly code: 'type.badge-icon-invalid' }
  | { readonly code: 'type.verification-mode-immutable' };

const CODE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const ICON_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;
const MAX_TERMS_PER_LOCALE = 200;
const MAX_TERM_LENGTH = 100;

export function isCertificationTypeCode(value: unknown): value is CertificationTypeCode {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}

// Plain text: no markup, no control characters (brief s5).
const hasMarkupOrControl = (s: string): boolean => /[<>\p{Cc}]/u.test(s);
const textOk = (s: unknown, max: number): boolean =>
  typeof s === 'string' && s.trim().length > 0 && s.length <= max && !hasMarkupOrControl(s);

/**
 * Validates a revision against the Market's `supportedLocales` and, when there is a previous
 * published revision, the immutability of `verificationMode` (H1). Every supported locale
 * needs a name and a description; claim terms may be empty for a locale.
 */
export function validateTypeRevision(
  content: TypeRevisionContent,
  supportedLocales: readonly string[],
  previous: TypeRevisionContent | null,
): Result<TypeRevisionContent, readonly TypeRevisionProblem[]> {
  const problems: TypeRevisionProblem[] = [];
  if (!(VERIFICATION_MODES as readonly string[]).includes(content.verificationMode)) {
    problems.push({ code: 'type.verification-mode-invalid' });
  } else if (previous !== null && previous.verificationMode !== content.verificationMode) {
    problems.push({ code: 'type.verification-mode-immutable' });
  }
  if (content.defaultBasis !== 'SELLER_REQUIRED' && content.defaultBasis !== 'NOT_APPLICABLE') {
    problems.push({ code: 'type.default-basis-invalid' });
  }
  if (content.autoApproveSelfDeclaration && content.verificationMode !== 'SELF_DECLARATION') {
    problems.push({ code: 'type.auto-approve-needs-self-declaration' });
  }
  if (!ICON_KEY_PATTERN.test(content.badgeIconKey))
    problems.push({ code: 'type.badge-icon-invalid' });
  for (const locale of Object.keys(content.locales)) {
    if (!supportedLocales.includes(locale)) {
      problems.push({ code: 'type.locale-not-supported', locale });
    }
  }
  for (const locale of supportedLocales) {
    const l = Object.hasOwn(content.locales, locale) ? content.locales[locale] : undefined;
    if (l === undefined || l === null || typeof l !== 'object') {
      problems.push({ code: 'type.locale-missing', locale });
      continue;
    }
    const termsOk =
      Array.isArray(l.claimTerms) &&
      l.claimTerms.length <= MAX_TERMS_PER_LOCALE &&
      l.claimTerms.every((t) => textOk(t, MAX_TERM_LENGTH));
    if (!textOk(l.name, MAX_NAME) || !textOk(l.customerDescription, MAX_DESCRIPTION) || !termsOk) {
      problems.push({ code: 'type.text-invalid', locale });
    }
  }
  return problems.length > 0 ? err(problems) : ok(content);
}

export type TypeRelaxation =
  | 'auto-approve-enabled'
  | 'document-no-longer-required'
  | 'issuer-registry-no-longer-required'
  | 'expiry-no-longer-required'
  | 'default-basis-relaxed'
  | 'claim-term-removed'
  | 'locale-dropped';

export interface TypeRevisionClassification {
  readonly relaxations: readonly TypeRelaxation[];
  /** True when the vocabulary changed in either direction, so catalog re-scans (design 3.6). */
  readonly claimTermsChanged: boolean;
}

const termKey = (t: string): string => normaliseClaimText(t);

/**
 * Compares a new revision with the published one. A revision that relaxes a setting, removes a
 * claim term in any locale or drops a locale waits for a second admin (design 3.6; Hassan C2).
 * Terms compare after normalisation, so a case-only edit is no removal.
 */
export function classifyTypeRevision(
  previous: TypeRevisionContent | null,
  next: TypeRevisionContent,
): TypeRevisionClassification {
  if (previous === null) return { relaxations: [], claimTermsChanged: true };
  const relaxations: TypeRelaxation[] = [];
  if (!previous.autoApproveSelfDeclaration && next.autoApproveSelfDeclaration) {
    relaxations.push('auto-approve-enabled');
  }
  if (previous.requiresDocument && !next.requiresDocument) {
    relaxations.push('document-no-longer-required');
  }
  if (previous.requiresIssuerRegistry && !next.requiresIssuerRegistry) {
    relaxations.push('issuer-registry-no-longer-required');
  }
  if (previous.requiresExpiry && !next.requiresExpiry)
    relaxations.push('expiry-no-longer-required');
  if (previous.defaultBasis === 'NOT_APPLICABLE' && next.defaultBasis === 'SELLER_REQUIRED') {
    relaxations.push('default-basis-relaxed');
  }
  let changed = false;
  let removed = false;
  let dropped = false;
  for (const locale of Object.keys(previous.locales)) {
    const before = new Set(previous.locales[locale]!.claimTerms.map(termKey));
    const nextLocale = Object.hasOwn(next.locales, locale) ? next.locales[locale] : undefined;
    const after = new Set((nextLocale?.claimTerms ?? []).map(termKey));
    if (nextLocale === undefined) {
      dropped = true;
      if (before.size > 0) changed = true;
      continue;
    }
    for (const t of before) if (!after.has(t)) removed = true;
    for (const t of after) if (!before.has(t)) changed = true;
    if (removed) changed = true;
  }
  for (const locale of Object.keys(next.locales)) {
    if (!Object.hasOwn(previous.locales, locale) && next.locales[locale]!.claimTerms.length > 0) {
      changed = true;
    }
  }
  if (removed) relaxations.push('claim-term-removed');
  if (dropped) relaxations.push('locale-dropped');
  return { relaxations, claimTermsChanged: changed };
}

export type Publication = 'publish-now' | 'pending-second-admin';

export const publicationOf = (c: TypeRevisionClassification): Publication =>
  c.relaxations.length > 0 ? 'pending-second-admin' : 'publish-now';

export type SecondAdminProblem = { readonly code: 'approval.same-admin' };

/** The approver of a relaxation, a reactivation or a policy relaxation is not its author (H1, Q3). */
export function assertSecondAdmin(
  authorAccountId: string,
  approverAccountId: string,
): Result<true, SecondAdminProblem> {
  return authorAccountId === approverAccountId ? err({ code: 'approval.same-admin' }) : ok(true);
}
