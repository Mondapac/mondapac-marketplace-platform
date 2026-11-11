import { ok } from '@mondapac/shared-kernel';
import {
  changedKeys,
  DEFAULT_SEO_SETTINGS,
  EDIT_KEYS,
  isValidAbn,
  MANAGE_KEYS,
  parseSeoSettings,
  publicSeoOf,
  SEO_SETTING_KEYS,
  seoKeyCode,
  seoKeyOfCode,
  touchesManage,
  type SeoSettings,
} from './seo-settings';

// The SEO settings object: every bound, every code of validation.failed, the split between the
// edit and the manage fields, and the public subset.

const valid = (overrides: Partial<SeoSettings> = {}): SeoSettings => ({
  ...DEFAULT_SEO_SETTINGS,
  ...overrides,
});
const parse = (input: unknown) => parseSeoSettings(input);
const problems = (input: unknown) => {
  const parsed = parse(input);
  return parsed.ok ? [] : parsed.error;
};
const IMAGE = { ref: 'brand-card', alt: 'The Mondapac logo' };
const ADDRESS = {
  street: '1 Queen St',
  city: 'Brisbane',
  state: 'QLD',
  postcode: '4000',
  country: 'AU',
};

describe('the defaults', () => {
  it('are valid, ship with indexing off and cover every key once', () => {
    expect(parse({ ...DEFAULT_SEO_SETTINGS })).toEqual(ok(DEFAULT_SEO_SETTINGS));
    expect(DEFAULT_SEO_SETTINGS.indexing).toBe('off');
    expect(new Set(SEO_SETTING_KEYS).size).toBe(SEO_SETTING_KEYS.length);
    expect(Object.keys(DEFAULT_SEO_SETTINGS).sort()).toEqual([...SEO_SETTING_KEYS].sort());
  });

  it('split every field into exactly one of the edit and the manage sets', () => {
    expect([...EDIT_KEYS, ...MANAGE_KEYS].sort()).toEqual([...SEO_SETTING_KEYS].sort());
    expect(MANAGE_KEYS).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(EDIT_KEYS).toEqual(
      expect.arrayContaining([
        'siteName',
        'titleTemplate',
        'defaultDescription',
        'defaultShareImage',
        'sellerPages',
        'sameAs',
        'pageTemplates',
      ]),
    );
  });

  it('give each key an audit code that maps back', () => {
    for (const key of SEO_SETTING_KEYS) {
      expect(seoKeyOfCode(seoKeyCode(key))).toBe(key);
      expect(seoKeyCode(key)).toMatch(/^[a-z][a-z0-9-]*$/);
    }
    expect(seoKeyOfCode('nonsense')).toBeNull();
  });
});

describe('parseSeoSettings', () => {
  it('refuses a non-object, a missing field and an unknown field', () => {
    expect(problems([])).toEqual([{ path: '', code: 'type' }]);
    expect(problems(null)).toEqual([{ path: '', code: 'type' }]);
    const without: Record<string, unknown> = { ...DEFAULT_SEO_SETTINGS };
    delete without.siteName;
    expect(problems(without)).toEqual([{ path: 'siteName', code: 'required' }]);
    expect(problems({ ...DEFAULT_SEO_SETTINGS, focusKeywords: ['x'] })).toEqual([
      { path: 'focusKeywords', code: 'unknown-field' },
    ]);
  });

  it.each([
    ['indexing', 'maybe', 'type'],
    ['indexing', true, 'type'],
    ['siteName', '', 'range'],
    ['siteName', 'x'.repeat(61), 'range'],
    ['siteName', 5, 'type'],
    ['siteName', 'Mon<b>dapac', 'format'],
    ['siteName', 'Mon\u0000dapac', 'format'],
    ['siteName', 'Mon‮dapac', 'format'],
    ['siteName', 'Mon dapac', 'format'],
    ['siteName', 'Mon​dapac', 'format'],
    ['titleTemplate', 'no title here', 'placeholder'],
    ['titleTemplate', '{title} | {unknown}', 'placeholder'],
    ['titleTemplate', '{title} {', 'placeholder'],
    ['titleTemplate', 'x'.repeat(41) + '{title}', 'range'],
    ['defaultDescription', 'too short', 'range'],
    ['defaultDescription', 'x'.repeat(161), 'range'],
    ['sellerPages', 'all', 'type'],
    ['abn', '12345678901', 'format'],
    ['abn', '5100 9', 'format'],
    ['abn', 12345678901, 'type'],
    ['contactEmail', 'not-an-email', 'format'],
    ['contactEmail', 'a@b', 'format'],
    ['contactPhone', '0412345678', 'format'],
    ['contactPhone', '+61 412 345 678', 'format'],
    ['googleVerification', 'short', 'format'],
    ['googleVerification', 'has space in the code', 'format'],
    ['bingVerification', 'x'.repeat(101), 'format'],
    ['analyticsId', 'UA-1234567-1', 'format'],
    ['analyticsId', 'G-lower', 'format'],
    ['analyticsId', 'G-' + 'A'.repeat(13), 'format'],
    ['tradingName', 'x'.repeat(101), 'range'],
    ['legalName', 'x'.repeat(151), 'range'],
    ['tradingName', 7, 'type'],
  ] as const)('refuses %s = %j with code %s', (path, value, code) => {
    expect(problems({ ...DEFAULT_SEO_SETTINGS, [path]: value })).toEqual([{ path, code }]);
  });

  it('trims and normalises text, and lets U+200C through (Persian)', () => {
    const parsed = parse({
      ...DEFAULT_SEO_SETTINGS,
      siteName: '  Monda‌pac  ',
      tradingName: '   ',
    });
    expect(parsed.ok && parsed.value.siteName).toBe('Monda‌pac');
    expect(parsed.ok && parsed.value.tradingName).toBeNull();
  });

  it('accepts the title template with {title} alone or with {site}', () => {
    expect(parse(valid({ titleTemplate: '{title}' })).ok).toBe(true);
    expect(parse(valid({ titleTemplate: '{site}: {title}' })).ok).toBe(true);
  });

  it('checks the ABN checksum and stores 11 digits', () => {
    expect(isValidAbn('51824753556')).toBe(true);
    expect(isValidAbn('51824753557')).toBe(false);
    expect(isValidAbn('5182475355')).toBe(false);
    expect(isValidAbn('5182475355a')).toBe(false);
    const parsed = parse(valid({ abn: '51 824 753 556' }));
    expect(parsed.ok && parsed.value.abn).toBe('51824753556');
  });

  it('lower-cases the contact email and accepts an E.164 phone', () => {
    const parsed = parse(
      valid({ contactEmail: 'Hello@Mondapac.COM.au', contactPhone: '+61412345678' }),
    );
    expect(parsed.ok && parsed.value.contactEmail).toBe('hello@mondapac.com.au');
    expect(parsed.ok && parsed.value.contactPhone).toBe('+61412345678');
  });

  it('accepts images by storage ref with alt 1 to 125, both or neither', () => {
    expect(parse(valid({ defaultShareImage: IMAGE, logo: IMAGE })).ok).toBe(true);
    expect(problems(valid({ defaultShareImage: { ref: 'brand-card', alt: '' } }))).toEqual([
      { path: 'defaultShareImage.alt', code: 'range' },
    ]);
    expect(problems(valid({ logo: { ref: 'brand-card', alt: 'x'.repeat(126) } }))).toEqual([
      { path: 'logo.alt', code: 'range' },
    ]);
    expect(problems(valid({ logo: { ref: 'Not A Ref', alt: 'ok' } }))).toEqual([
      { path: 'logo.ref', code: 'format' },
    ]);
    expect(problems(valid({ logo: { ref: 'brand-card' } as never }))).toEqual([
      { path: 'logo.alt', code: 'required' },
    ]);
    expect(problems(valid({ logo: { ref: 'brand-card', alt: 'ok', url: 'x' } as never }))).toEqual([
      { path: 'logo.url', code: 'unknown-field' },
    ]);
    expect(problems(valid({ logo: 'brand-card' as never }))).toEqual([
      { path: 'logo', code: 'type' },
    ]);
  });

  it('accepts a full postal address and refuses a partial or malformed one', () => {
    expect(parse(valid({ postalAddress: ADDRESS })).ok).toBe(true);
    expect(problems(valid({ postalAddress: { ...ADDRESS, postcode: '4' } }))).toEqual([
      { path: 'postalAddress.postcode', code: 'range' },
    ]);
    expect(problems(valid({ postalAddress: { ...ADDRESS, country: 'Australia' } }))).toEqual([
      { path: 'postalAddress.country', code: 'format' },
    ]);
    expect(problems(valid({ postalAddress: { ...ADDRESS, city: '<b>' } }))).toEqual([
      { path: 'postalAddress.city', code: 'format' },
    ]);
    const partial: Record<string, unknown> = { ...ADDRESS };
    delete partial.state;
    expect(problems(valid({ postalAddress: partial as never }))).toEqual([
      { path: 'postalAddress.state', code: 'type' },
    ]);
  });

  describe('sameAs', () => {
    it('keeps at most 10 https URLs, in canonical form, once each', () => {
      const parsed = parse(
        valid({
          sameAs: [
            'https://www.facebook.com/mondapac',
            'https://www.facebook.com/mondapac',
            ' https://x.com/mondapac ',
          ],
        }),
      );
      expect(parsed.ok && parsed.value.sameAs).toEqual([
        'https://www.facebook.com/mondapac',
        'https://x.com/mondapac',
      ]);
    });

    it.each([
      ['http://x.com/a'],
      ['javascript:alert(1)'],
      ['//x.com/a'],
      ['https://user:pass@x.com/a'],
      ['https://'],
      ['https://x.com/<script>'],
      ['ftp://x.com'],
    ])('refuses %s', (url) => {
      expect(problems(valid({ sameAs: [url] }))).toEqual([{ path: 'sameAs[0]', code: 'format' }]);
    });

    it('bounds the stored (canonical) form, which can be far longer than the typed one', () => {
      const typed = `https://fa.wikipedia.org/wiki/${'سلام'.repeat(40)}`;
      expect(typed.length).toBeLessThanOrEqual(200);
      expect(problems(valid({ sameAs: [typed] }))).toEqual([{ path: 'sameAs[0]', code: 'format' }]);
    });

    it('refuses more than 10, a non-list and a non-string', () => {
      const many = Array.from({ length: 11 }, (_, n) => `https://x.com/${n}`);
      expect(problems(valid({ sameAs: many }))).toEqual([{ path: 'sameAs', code: 'range' }]);
      expect(problems(valid({ sameAs: 'https://x.com' as never }))).toEqual([
        { path: 'sameAs', code: 'type' },
      ]);
      expect(problems(valid({ sameAs: [5 as never] }))).toEqual([
        { path: 'sameAs[0]', code: 'type' },
      ]);
    });
  });

  describe('page templates', () => {
    const templates = (patch: Record<string, unknown>) => ({
      ...DEFAULT_SEO_SETTINGS.pageTemplates,
      ...patch,
    });

    it('accept the allowed placeholders of each page type', () => {
      const parsed = parse(
        valid({
          pageTemplates: templates({
            category: {
              title: '{category} | {parent}',
              description: 'Shop {count} {category} products.',
            },
            product: { title: '{product} from {seller}', description: '{summary}' },
            seller: { title: '{seller}', description: '{seller} in {city}: {count} products.' },
            sellers: { title: 'Sellers', description: 'Browse {count} local sellers.' },
            home: { title: '{site}: halal groceries', description: null },
            landing: { title: '{title}', description: null },
          }),
        }),
      );
      expect(parsed.ok).toBe(true);
    });

    it.each([
      ['home', 'title', '{category}'],
      ['category', 'description', '{price}'],
      ['product', 'title', '{stock} left'],
      ['sellers', 'title', '{seller}'],
      ['seller', 'title', '{{seller}}'],
      ['landing', 'description', '{site}'],
      ['category', 'title', 'half {open'],
      ['category', 'title', 'empty {}'],
    ])('refuse %s.%s = %j (placeholder)', (type, field, value) => {
      const got = problems(
        valid({
          pageTemplates: templates({ [type]: { title: null, description: null, [field]: value } }),
        }),
      );
      expect(got).toEqual([{ path: `pageTemplates.${type}.${field}`, code: 'placeholder' }]);
    });

    it('refuse a missing type, an unknown type, an unknown key, markup and length', () => {
      const missing: Record<string, unknown> = { ...DEFAULT_SEO_SETTINGS.pageTemplates };
      delete missing.landing;
      expect(problems(valid({ pageTemplates: missing as never }))).toEqual([
        { path: 'pageTemplates.landing', code: 'required' },
      ]);
      expect(problems(valid({ pageTemplates: templates({ blog: {} }) }))).toEqual([
        { path: 'pageTemplates.blog', code: 'unknown-field' },
      ]);
      expect(
        problems(
          valid({ pageTemplates: templates({ home: { title: null, description: null, x: 1 } }) }),
        ),
      ).toEqual([{ path: 'pageTemplates.home.x', code: 'unknown-field' }]);
      expect(
        problems(
          valid({ pageTemplates: templates({ home: { title: '<b>{site}', description: null } }) }),
        ),
      ).toEqual([{ path: 'pageTemplates.home.title', code: 'format' }]);
      expect(
        problems(
          valid({
            pageTemplates: templates({ home: { title: 'x'.repeat(121), description: null } }),
          }),
        ),
      ).toEqual([{ path: 'pageTemplates.home.title', code: 'range' }]);
      expect(
        problems(
          valid({
            pageTemplates: templates({ home: { title: null, description: 'x'.repeat(161) } }),
          }),
        ),
      ).toEqual([{ path: 'pageTemplates.home.description', code: 'range' }]);
    });

    it('treat an empty text as the code default (null)', () => {
      const parsed = parse(
        valid({ pageTemplates: templates({ home: { title: '  ', description: '' } }) }),
      );
      expect(parsed.ok && parsed.value.pageTemplates.home).toEqual({
        title: null,
        description: null,
      });
    });
  });
});

describe('changedKeys and the manage split', () => {
  it('names only the fields that differ', () => {
    const next = valid({ siteName: 'Other', analyticsId: 'G-ABCDEF1' });
    expect(changedKeys(DEFAULT_SEO_SETTINGS, next)).toEqual(['siteName', 'analyticsId']);
    expect(changedKeys(next, next)).toEqual([]);
  });

  it('needs manage for indexing, logo, business details and tool codes only', () => {
    expect(touchesManage(['siteName', 'sameAs', 'pageTemplates'])).toBe(false);
    for (const key of MANAGE_KEYS) expect(touchesManage([key])).toBe(true);
  });
});

describe('the public subset', () => {
  it('holds the public fields and nothing that identifies a version or an editor', () => {
    const body = publicSeoOf(
      valid({ logo: IMAGE, abn: '51824753556', sameAs: ['https://x.com/a'] }),
    );
    expect(Object.keys(body).sort()).toEqual(
      [
        'analyticsId',
        'defaultDescription',
        'indexing',
        'logo',
        'organization',
        'sellerPages',
        'shareImage',
        'siteName',
        'templates',
        'titleTemplate',
        'verification',
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toMatch(/version|changedBy|focus|keyword/i);
  });
});
