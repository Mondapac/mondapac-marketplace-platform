import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

// The SEO settings of a Market (SEO admin plan, sections 2 to 5; package S1). One immutable version
// per save: the settings in force are the row with the highest version, version 0 is the code
// defaults below. Free text is plain: no control or format character (U+200C stays, Persian needs
// it), no line or paragraph separator, no `<` or `>`, trimmed. The database CHECKs repeat the
// bounds. Focus keywords and per-page overrides are package S2, not here.

export const INDEXING_VALUES = ['off', 'on'] as const;
export const SELLER_PAGES_VALUES = ['with-products', 'none'] as const;
export type Indexing = (typeof INDEXING_VALUES)[number];
export type SellerPages = (typeof SELLER_PAGES_VALUES)[number];

/** The page types a template can be set for (plan 2.4). Search, cart and the like are never indexed. */
export const TEMPLATE_PAGE_TYPES = [
  'home',
  'category',
  'product',
  'seller',
  'sellers',
  'landing',
] as const;
export type TemplatePageType = (typeof TEMPLATE_PAGE_TYPES)[number];

/** The placeholders each page type's templates may use (plan 2.4). Price and stock have none. */
export const TEMPLATE_PLACEHOLDERS: Readonly<Record<TemplatePageType, readonly string[]>> =
  Object.freeze({
    home: ['site'],
    category: ['category', 'parent', 'count'],
    product: ['product', 'seller', 'category', 'summary'],
    seller: ['seller', 'city', 'count'],
    sellers: ['count'],
    landing: ['title'],
  });

export interface ShareImage {
  /** A ready-made image key (the storage reference), until catalog media serves arbitrary refs. */
  readonly ref: string;
  /** Alt text, 1 to 125 characters. */
  readonly alt: string;
}

export interface PostalAddress {
  readonly street: string;
  readonly city: string;
  readonly state: string;
  readonly postcode: string;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
}

export interface PageTemplate {
  /** null: the code default of that page type. */
  readonly title: string | null;
  readonly description: string | null;
}

export type PageTemplates = Readonly<Record<TemplatePageType, PageTemplate>>;

export interface SeoSettings {
  // 2.1 Whole site
  /** G1. */
  readonly indexing: Indexing;
  /** G2. */
  readonly siteName: string;
  /** G3: contains `{title}`, optionally `{site}`. */
  readonly titleTemplate: string;
  /** G4. */
  readonly defaultDescription: string;
  /** G5. */
  readonly defaultShareImage: ShareImage | null;
  /** G6. */
  readonly logo: ShareImage | null;
  /** G7. */
  readonly sellerPages: SellerPages;
  // 2.2 Business
  /** B1. */
  readonly tradingName: string | null;
  /** B2. */
  readonly legalName: string | null;
  /** B3: 11 digits, ABN checksum. */
  readonly abn: string | null;
  /** B4. */
  readonly postalAddress: PostalAddress | null;
  /** B5. */
  readonly contactEmail: string | null;
  /** B5, E.164. */
  readonly contactPhone: string | null;
  /** B6: at most 10 `https://` URLs. */
  readonly sameAs: readonly string[];
  // 2.3 Tools
  /** T1. */
  readonly googleVerification: string | null;
  /** T2. */
  readonly bingVerification: string | null;
  /** T3: stored only; nothing loads it yet. */
  readonly analyticsId: string | null;
  // 2.4 Page types
  readonly pageTemplates: PageTemplates;
}

export type SeoSettingKey = keyof SeoSettings;

export const SEO_SETTING_KEYS = [
  'indexing',
  'siteName',
  'titleTemplate',
  'defaultDescription',
  'defaultShareImage',
  'logo',
  'sellerPages',
  'tradingName',
  'legalName',
  'abn',
  'postalAddress',
  'contactEmail',
  'contactPhone',
  'sameAs',
  'googleVerification',
  'bingVerification',
  'analyticsId',
  'pageTemplates',
] as const satisfies readonly SeoSettingKey[];

/** An audit enum value is a lower-case code: `siteName` is written `site-name` in the audit row. */
export const SEO_SETTING_CODES = SEO_SETTING_KEYS.map((key) =>
  key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`),
) as unknown as readonly [string, ...string[]];

export const seoKeyCode = (key: SeoSettingKey): string =>
  SEO_SETTING_CODES[SEO_SETTING_KEYS.indexOf(key)]!;

/** The setting name an audit code stands for, or null for a code that is not one. */
export function seoKeyOfCode(code: string): SeoSettingKey | null {
  const index = SEO_SETTING_CODES.indexOf(code);
  return index === -1 ? null : SEO_SETTING_KEYS[index]!;
}

/**
 * The fields only `storefront.seo.manage` changes (plan 4.1): G1, G6, B1 to B5 and T1 to T3. Every
 * other field needs `storefront.seo.edit`. The two sets together are every field.
 */
export const MANAGE_KEYS = [
  'indexing',
  'logo',
  'tradingName',
  'legalName',
  'abn',
  'postalAddress',
  'contactEmail',
  'contactPhone',
  'googleVerification',
  'bingVerification',
  'analyticsId',
] as const satisfies readonly SeoSettingKey[];

export const EDIT_KEYS = [
  'siteName',
  'titleTemplate',
  'defaultDescription',
  'defaultShareImage',
  'sellerPages',
  'sameAs',
  'pageTemplates',
] as const satisfies readonly SeoSettingKey[];

export const BOUNDS = Object.freeze({
  siteName: 60,
  titleTemplate: 40,
  defaultDescription: { min: 50, max: 160 },
  imageAlt: { min: 1, max: 125 },
  tradingName: 100,
  legalName: 150,
  street: 100,
  city: 60,
  state: 30,
  postcode: { min: 3, max: 10 },
  contactEmail: 254,
  sameAsCount: 10,
  sameAsLength: 200,
  templateTitle: 120,
  templateDescription: 160,
});

const NO_TEMPLATE: PageTemplate = Object.freeze({ title: null, description: null });

/** Version 0: what is in force before an admin saves anything. Indexing is off. */
export const DEFAULT_SEO_SETTINGS: SeoSettings = Object.freeze({
  indexing: 'off',
  siteName: 'Mondapac',
  titleTemplate: '{title} | {site}',
  defaultDescription:
    'Mondapac is an online marketplace where local sellers list their products for delivery to your door.',
  defaultShareImage: null,
  logo: null,
  sellerPages: 'with-products',
  tradingName: null,
  legalName: null,
  abn: null,
  postalAddress: null,
  contactEmail: null,
  contactPhone: null,
  sameAs: Object.freeze([]),
  googleVerification: null,
  bingVerification: null,
  analyticsId: null,
  pageTemplates: Object.freeze({
    home: NO_TEMPLATE,
    category: NO_TEMPLATE,
    product: NO_TEMPLATE,
    seller: NO_TEMPLATE,
    sellers: NO_TEMPLATE,
    landing: NO_TEMPLATE,
  }),
});

export interface FieldError {
  readonly path: string;
  readonly code: 'type' | 'range' | 'format' | 'required' | 'unknown-field' | 'placeholder';
}

// Controls, invisible format characters (bidirectional marks, overrides and isolates: a visual
// spoof), line and paragraph separators, and markup characters. U+200C stays allowed. The
// database CHECKs repeat this list.
const FORBIDDEN_TEXT = /(?!‌)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;
const IMAGE_REF = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const VERIFICATION = /^[A-Za-z0-9_-]{10,100}$/u;
const GA4 = /^G-[A-Z0-9]{6,12}$/u;
const E164 = /^\+[1-9][0-9]{7,14}$/u;
const EMAIL =
  /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
const PLACEHOLDER = /\{([^{}]*)\}/gu;
const COUNTRY = /^[A-Z]{2}$/u;
const POSTCODE = /^[A-Za-z0-9 -]+$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const length = (text: string): number => Array.from(text).length;

type Errors = FieldError[];
const MAX_ERRORS = 20;
const fail = (errors: Errors, path: string, code: FieldError['code']): void => {
  if (errors.length < MAX_ERRORS) errors.push({ path, code });
};

/** A plain text as stored: NFC, trimmed. Null when there is none (an empty text counts as none). */
function plain(
  value: unknown,
  path: string,
  errors: Errors,
  bounds: { min: number; max: number },
): string | null {
  if (typeof value !== 'string') {
    fail(errors, path, 'type');
    return null;
  }
  const text = value.normalize('NFC').trim();
  if (FORBIDDEN_TEXT.test(text)) {
    fail(errors, path, 'format');
    return null;
  }
  const size = length(text);
  if (size < bounds.min || size > bounds.max) {
    fail(errors, path, 'range');
    return null;
  }
  return text;
}

/** An optional plain text: null (or an empty text) clears it. */
function optionalPlain(value: unknown, path: string, errors: Errors, max: number): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && value.normalize('NFC').trim() === '') return null;
  return plain(value, path, errors, { min: 1, max });
}

function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  path: string,
  errors: Errors,
  fallback: T,
): T {
  if (typeof value === 'string' && (options as readonly string[]).includes(value)) {
    return value as T;
  }
  fail(errors, path, 'type');
  return fallback;
}

/** Only the keys of `allowed`, each at most once (an object has no repeats); extra keys are errors. */
function closed(
  value: unknown,
  allowed: readonly string[],
  path: string,
  errors: Errors,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    fail(errors, path, 'type');
    return null;
  }
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) {
      const safe = Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�');
      fail(errors, path === '' ? safe : `${path}.${safe}`, 'unknown-field');
    }
  }
  return value;
}

function imageOf(value: unknown, path: string, errors: Errors): ShareImage | null {
  if (value === null) return null;
  const raw = closed(value, ['ref', 'alt'], path, errors);
  if (raw === null) return null;
  const ref = raw.ref;
  let validRef: string | null = null;
  if (typeof ref !== 'string') fail(errors, `${path}.ref`, ref === undefined ? 'required' : 'type');
  else if (!IMAGE_REF.test(ref)) fail(errors, `${path}.ref`, 'format');
  else validRef = ref;
  const alt =
    raw.alt === undefined
      ? (fail(errors, `${path}.alt`, 'required'), null)
      : plain(raw.alt, `${path}.alt`, errors, BOUNDS.imageAlt);
  return validRef !== null && alt !== null ? { ref: validRef, alt } : null;
}

/** An Australian Business Number: 11 digits, passes the ABN checksum (subtract 1 from the first digit, weights 10 1 3 5 7 9 11 13 15 17 19, sum divisible by 89). */
export function isValidAbn(value: string): boolean {
  if (!/^[0-9]{11}$/u.test(value)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const digits = Array.from(value, Number);
  digits[0] = digits[0]! - 1;
  const sum = digits.reduce((total, digit, index) => total + digit * weights[index]!, 0);
  return sum % 89 === 0;
}

function addressOf(value: unknown, errors: Errors): PostalAddress | null {
  if (value === null) return null;
  const path = 'postalAddress';
  const raw = closed(value, ['street', 'city', 'state', 'postcode', 'country'], path, errors);
  if (raw === null) return null;
  const before = errors.length;
  const street = plain(raw.street, `${path}.street`, errors, { min: 1, max: BOUNDS.street });
  const city = plain(raw.city, `${path}.city`, errors, { min: 1, max: BOUNDS.city });
  const state = plain(raw.state, `${path}.state`, errors, { min: 1, max: BOUNDS.state });
  const postcode = plain(raw.postcode, `${path}.postcode`, errors, BOUNDS.postcode);
  if (postcode !== null && !POSTCODE.test(postcode)) fail(errors, `${path}.postcode`, 'format');
  const country = raw.country;
  if (typeof country !== 'string') fail(errors, `${path}.country`, 'type');
  else if (!COUNTRY.test(country)) fail(errors, `${path}.country`, 'format');
  if (errors.length > before) return null;
  return {
    street: street!,
    city: city!,
    state: state!,
    postcode: postcode!,
    country: country as string,
  };
}

function sameAsOf(value: unknown, errors: Errors): readonly string[] {
  if (!Array.isArray(value)) {
    fail(errors, 'sameAs', 'type');
    return [];
  }
  if (value.length > BOUNDS.sameAsCount) {
    fail(errors, 'sameAs', 'range');
    return [];
  }
  const urls: string[] = [];
  value.forEach((entry: unknown, index) => {
    const path = `sameAs[${index}]`;
    if (typeof entry !== 'string') return fail(errors, path, 'type');
    const text = entry.trim();
    if (
      FORBIDDEN_TEXT.test(text) ||
      length(text) > BOUNDS.sameAsLength ||
      !text.startsWith('https://')
    ) {
      return fail(errors, path, 'format');
    }
    try {
      const url = new URL(text);
      if (
        url.protocol !== 'https:' ||
        url.hostname === '' ||
        url.username !== '' ||
        url.password !== ''
      ) {
        return fail(errors, path, 'format');
      }
      // The canonical form, so two spellings of one page count once.
      const canonical = url.toString();
      if (!urls.includes(canonical)) urls.push(canonical);
    } catch {
      fail(errors, path, 'format');
    }
  });
  return urls;
}

function codeOf(value: unknown, pattern: RegExp, path: string, errors: Errors): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    fail(errors, path, 'type');
    return null;
  }
  if (!pattern.test(value)) {
    fail(errors, path, 'format');
    return null;
  }
  return value;
}

/** The placeholders of a template that the page type does not allow. */
function badPlaceholder(template: string, allowed: readonly string[]): boolean {
  const stripped = template.replace(PLACEHOLDER, (_, name: string) =>
    allowed.includes(name) ? '' : '\u0000',
  );
  // An unknown name, or a brace left over (unbalanced or empty), is refused.
  return stripped.includes('\u0000') || /[{}]/u.test(stripped);
}

function templateText(
  value: unknown,
  path: string,
  errors: Errors,
  max: number,
  allowed: readonly string[],
): string | null {
  const text = optionalPlain(value, path, errors, max);
  if (text !== null && badPlaceholder(text, allowed)) fail(errors, path, 'placeholder');
  return text;
}

function templatesOf(value: unknown, errors: Errors): PageTemplates {
  const raw = closed(value, TEMPLATE_PAGE_TYPES, 'pageTemplates', errors);
  const out = {} as Record<TemplatePageType, PageTemplate>;
  for (const type of TEMPLATE_PAGE_TYPES) {
    const path = `pageTemplates.${type}`;
    const entry = raw?.[type];
    if (entry === undefined) {
      if (raw !== null) fail(errors, path, 'required');
      out[type] = NO_TEMPLATE;
      continue;
    }
    const template = closed(entry, ['title', 'description'], path, errors);
    if (template === null) {
      out[type] = NO_TEMPLATE;
      continue;
    }
    const allowed = TEMPLATE_PLACEHOLDERS[type];
    out[type] = {
      title: templateText(template.title, `${path}.title`, errors, BOUNDS.templateTitle, allowed),
      description: templateText(
        template.description,
        `${path}.description`,
        errors,
        BOUNDS.templateDescription,
        allowed,
      ),
    };
  }
  return out;
}

/** Validates a full settings object: every field required, no other key. */
export function parseSeoSettings(input: unknown): Result<SeoSettings, readonly FieldError[]> {
  const errors: Errors = [];
  const raw = closed(input, SEO_SETTING_KEYS, '', errors);
  if (raw === null) return err(errors);
  for (const key of SEO_SETTING_KEYS) {
    if (raw[key] === undefined) fail(errors, key, 'required');
  }
  if (errors.length > 0) return err(errors);

  const indexing = oneOf(raw.indexing, INDEXING_VALUES, 'indexing', errors, 'off');
  const siteName = plain(raw.siteName, 'siteName', errors, { min: 1, max: BOUNDS.siteName });
  const titleTemplate = plain(raw.titleTemplate, 'titleTemplate', errors, {
    min: 1,
    max: BOUNDS.titleTemplate,
  });
  if (titleTemplate !== null) {
    if (!titleTemplate.includes('{title}')) fail(errors, 'titleTemplate', 'placeholder');
    else if (badPlaceholder(titleTemplate, ['title', 'site'])) {
      fail(errors, 'titleTemplate', 'placeholder');
    }
  }
  const defaultDescription = plain(
    raw.defaultDescription,
    'defaultDescription',
    errors,
    BOUNDS.defaultDescription,
  );
  const defaultShareImage = imageOf(raw.defaultShareImage, 'defaultShareImage', errors);
  const logo = imageOf(raw.logo, 'logo', errors);
  const sellerPages = oneOf(raw.sellerPages, SELLER_PAGES_VALUES, 'sellerPages', errors, 'none');

  const tradingName = optionalPlain(raw.tradingName, 'tradingName', errors, BOUNDS.tradingName);
  const legalName = optionalPlain(raw.legalName, 'legalName', errors, BOUNDS.legalName);
  let abn: string | null = null;
  if (raw.abn !== null) {
    if (typeof raw.abn !== 'string') fail(errors, 'abn', 'type');
    else {
      // Spaces are how an ABN is written; the stored form is 11 digits.
      const digits = raw.abn.replace(/ /gu, '');
      if (isValidAbn(digits)) abn = digits;
      else fail(errors, 'abn', 'format');
    }
  }
  const postalAddress = addressOf(raw.postalAddress, errors);
  let contactEmail = optionalPlain(raw.contactEmail, 'contactEmail', errors, BOUNDS.contactEmail);
  if (contactEmail !== null) {
    contactEmail = contactEmail.toLowerCase();
    if (!EMAIL.test(contactEmail)) {
      fail(errors, 'contactEmail', 'format');
      contactEmail = null;
    }
  }
  const contactPhone = codeOf(raw.contactPhone, E164, 'contactPhone', errors);
  const sameAs = sameAsOf(raw.sameAs, errors);

  const googleVerification = codeOf(
    raw.googleVerification,
    VERIFICATION,
    'googleVerification',
    errors,
  );
  const bingVerification = codeOf(raw.bingVerification, VERIFICATION, 'bingVerification', errors);
  const analyticsId = codeOf(raw.analyticsId, GA4, 'analyticsId', errors);
  const pageTemplates = templatesOf(raw.pageTemplates, errors);

  if (errors.length > 0) return err(errors);
  return ok({
    indexing,
    siteName: siteName!,
    titleTemplate: titleTemplate!,
    defaultDescription: defaultDescription!,
    defaultShareImage,
    logo,
    sellerPages,
    tradingName,
    legalName,
    abn,
    postalAddress,
    contactEmail,
    contactPhone,
    sameAs,
    googleVerification,
    bingVerification,
    analyticsId,
    pageTemplates,
  });
}

/** Whether two settings objects are equal field for field. */
export function sameSettings(a: SeoSettings, b: SeoSettings): boolean {
  return changedKeys(a, b).length === 0;
}

/** The names of the fields whose value differs. Names only. */
export function changedKeys(a: SeoSettings, b: SeoSettings): SeoSettingKey[] {
  return SEO_SETTING_KEYS.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

/** Whether any of the changed fields needs the manage key. */
export function touchesManage(keys: readonly SeoSettingKey[]): boolean {
  return keys.some((key) => (MANAGE_KEYS as readonly string[]).includes(key));
}

/** Whether any of the changed fields needs the edit key. */
export function touchesEdit(keys: readonly SeoSettingKey[]): boolean {
  return keys.some((key) => (EDIT_KEYS as readonly string[]).includes(key));
}

/** The fields the public read answers (plan 3.2 item 1): never the version or the editor. */
export interface PublicSeo {
  readonly indexing: Indexing;
  readonly siteName: string;
  readonly titleTemplate: string;
  readonly defaultDescription: string;
  readonly shareImage: ShareImage | null;
  readonly logo: ShareImage | null;
  readonly sellerPages: SellerPages;
  readonly organization: {
    readonly tradingName: string | null;
    readonly legalName: string | null;
    readonly abn: string | null;
    readonly postalAddress: PostalAddress | null;
    readonly contactEmail: string | null;
    readonly contactPhone: string | null;
    readonly sameAs: readonly string[];
  };
  readonly verification: { readonly google: string | null; readonly bing: string | null };
  readonly analyticsId: string | null;
  readonly templates: PageTemplates;
}

export function publicSeoOf(settings: SeoSettings): PublicSeo {
  return {
    indexing: settings.indexing,
    siteName: settings.siteName,
    titleTemplate: settings.titleTemplate,
    defaultDescription: settings.defaultDescription,
    shareImage: settings.defaultShareImage,
    logo: settings.logo,
    sellerPages: settings.sellerPages,
    organization: {
      tradingName: settings.tradingName,
      legalName: settings.legalName,
      abn: settings.abn,
      postalAddress: settings.postalAddress,
      contactEmail: settings.contactEmail,
      contactPhone: settings.contactPhone,
      sameAs: settings.sameAs,
    },
    verification: { google: settings.googleVerification, bing: settings.bingVerification },
    analyticsId: settings.analyticsId,
    templates: settings.pageTemplates,
  };
}
