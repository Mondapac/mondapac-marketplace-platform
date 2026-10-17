import type {
  TypeDefaultBasis,
  TypeLocaleContent,
  TypeRevisionContent,
  VerificationMode,
} from '../../domain/type-revision';

// The input shape of a type revision save (design 3.6): a closed object. Only its shape is
// checked here; its values are the domain's (`validateTypeRevision`). `verificationMode` may be
// omitted: it is the type's for ever (H1), and a different one is the domain's refusal.

const CONTENT_KEYS = [
  'verificationMode',
  'requiresIssuerRegistry',
  'requiresDocument',
  'requiresExpiry',
  'defaultBasis',
  'autoApproveSelfDeclaration',
  'badgeIconKey',
  'locales',
] as const;
const LOCALE_KEYS = ['name', 'customerDescription', 'claimTerms'] as const;
const BOOLEAN_KEYS = [
  'requiresIssuerRegistry',
  'requiresDocument',
  'requiresExpiry',
  'autoApproveSelfDeclaration',
] as const;
const MAX_LOCALES = 16;

export type ContentProblem = { readonly path: string; readonly code: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The content of a revision from a request body, or the first problems (at most 10). */
export function typeRevisionContentIn(
  raw: unknown,
  typeMode: VerificationMode,
): { ok: true; value: TypeRevisionContent } | { ok: false; problems: readonly ContentProblem[] } {
  if (!isRecord(raw)) return { ok: false, problems: [{ path: 'content', code: 'type' }] };
  const problems: ContentProblem[] = [];
  for (const key of Object.keys(raw)) {
    if (!(CONTENT_KEYS as readonly string[]).includes(key)) {
      problems.push({ path: `content.${key.slice(0, 64)}`, code: 'unknown-field' });
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof raw[key] !== 'boolean') problems.push({ path: `content.${key}`, code: 'type' });
  }
  if (typeof raw.defaultBasis !== 'string') {
    problems.push({ path: 'content.defaultBasis', code: 'type' });
  }
  if (typeof raw.badgeIconKey !== 'string') {
    problems.push({ path: 'content.badgeIconKey', code: 'type' });
  }
  if (raw.verificationMode !== undefined && typeof raw.verificationMode !== 'string') {
    problems.push({ path: 'content.verificationMode', code: 'type' });
  }
  const locales: Record<string, TypeLocaleContent> = {};
  if (!isRecord(raw.locales)) {
    problems.push({ path: 'content.locales', code: 'type' });
  } else if (Object.keys(raw.locales).length > MAX_LOCALES) {
    problems.push({ path: 'content.locales', code: 'too-many' });
  } else {
    for (const [locale, entry] of Object.entries(raw.locales)) {
      const path = `content.locales.${locale.slice(0, 16)}`;
      if (!isRecord(entry)) {
        problems.push({ path, code: 'type' });
        continue;
      }
      const unknown = Object.keys(entry).find(
        (key) => !(LOCALE_KEYS as readonly string[]).includes(key),
      );
      if (unknown !== undefined) {
        problems.push({ path: `${path}.${unknown.slice(0, 64)}`, code: 'unknown-field' });
        continue;
      }
      if (
        typeof entry.name !== 'string' ||
        typeof entry.customerDescription !== 'string' ||
        !Array.isArray(entry.claimTerms) ||
        !entry.claimTerms.every((term) => typeof term === 'string')
      ) {
        problems.push({ path, code: 'type' });
        continue;
      }
      locales[locale] = {
        name: entry.name.trim(),
        customerDescription: entry.customerDescription.trim(),
        claimTerms: [...new Set(entry.claimTerms.map((term) => term.trim()))],
      };
    }
  }
  if (problems.length > 0) return { ok: false, problems: problems.slice(0, 10) };
  return {
    ok: true,
    value: {
      verificationMode: (raw.verificationMode as VerificationMode | undefined) ?? typeMode,
      requiresIssuerRegistry: raw.requiresIssuerRegistry as boolean,
      requiresDocument: raw.requiresDocument as boolean,
      requiresExpiry: raw.requiresExpiry as boolean,
      defaultBasis: raw.defaultBasis as TypeDefaultBasis,
      autoApproveSelfDeclaration: raw.autoApproveSelfDeclaration as boolean,
      badgeIconKey: raw.badgeIconKey as string,
      locales,
    },
  };
}
