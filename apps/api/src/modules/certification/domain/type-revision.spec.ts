import {
  assertSecondAdmin,
  classifyTypeRevision,
  isCertificationTypeCode,
  publicationOf,
  validateTypeRevision,
  type TypeRevisionContent,
} from './type-revision';

const base = (over: Partial<TypeRevisionContent> = {}): TypeRevisionContent => ({
  verificationMode: 'THIRD_PARTY_DOCUMENT',
  requiresIssuerRegistry: true,
  requiresDocument: true,
  requiresExpiry: true,
  defaultBasis: 'SELLER_REQUIRED',
  autoApproveSelfDeclaration: false,
  badgeIconKey: 'seal',
  locales: {
    en: {
      name: 'Halal',
      customerDescription: 'Certified.',
      claimTerms: ['halal', 'halal certified'],
    },
    ar: { name: 'حلال', customerDescription: 'معتمد', claimTerms: ['حلال'] },
  },
  ...over,
});
const LOCALES = ['en', 'ar'];

// A synthetic Market: other locales, a self-declared type.
const zz = (over: Partial<TypeRevisionContent> = {}): TypeRevisionContent => ({
  verificationMode: 'SELF_DECLARATION',
  requiresIssuerRegistry: false,
  requiresDocument: false,
  requiresExpiry: false,
  defaultBasis: 'NOT_APPLICABLE',
  autoApproveSelfDeclaration: true,
  badgeIconKey: 'leaf',
  locales: {
    zz: { name: 'Zed', customerDescription: 'Zed pure.', claimTerms: ['zedpure', 'зед чисто'] },
  },
  ...over,
});

describe('type code', () => {
  it('accepts the pattern and rejects the rest', () => {
    expect(isCertificationTypeCode('halal')).toBe(true);
    expect(isCertificationTypeCode('zed-pure')).toBe(true);
    for (const bad of ['', 'H', 'Halal', '1abc', 'a', 'a'.repeat(33), 'a b', 5, null]) {
      expect(isCertificationTypeCode(bad)).toBe(false);
    }
  });
});

describe('validateTypeRevision', () => {
  it('accepts a complete revision for both Market fixtures', () => {
    expect(validateTypeRevision(base(), LOCALES, null).ok).toBe(true);
    expect(validateTypeRevision(zz(), ['zz'], null).ok).toBe(true);
  });

  const problems = (
    c: TypeRevisionContent,
    locales = LOCALES,
    prev: TypeRevisionContent | null = null,
  ) => {
    const r = validateTypeRevision(c, locales, prev);
    return r.ok ? [] : r.error.map((p) => p.code);
  };

  it('refuses a changed verification mode (H1)', () => {
    expect(problems(zz(), ['zz'], base({ locales: zz().locales }))).toContain(
      'type.verification-mode-immutable',
    );
  });

  it('refuses auto-approve outside SELF_DECLARATION', () => {
    expect(problems(base({ autoApproveSelfDeclaration: true }))).toContain(
      'type.auto-approve-needs-self-declaration',
    );
  });

  it('refuses a default that is not SELLER_REQUIRED or NOT_APPLICABLE', () => {
    expect(problems(base({ defaultBasis: 'SELLER_OR_MANUFACTURER' as never }))).toContain(
      'type.default-basis-invalid',
    );
  });

  it('refuses locales outside the Market and missing ones', () => {
    const c = base({ locales: { en: base().locales.en!, fr: base().locales.en! } });
    expect(problems(c)).toEqual(
      expect.arrayContaining(['type.locale-not-supported', 'type.locale-missing']),
    );
  });

  it('refuses markup, control characters and empty text', () => {
    const l = (name: string, terms: string[] = ['halal']) => ({
      en: { name, customerDescription: 'ok', claimTerms: terms },
      ar: base().locales.ar!,
    });
    expect(problems(base({ locales: l('<b>x</b>') }))).toContain('type.text-invalid');
    expect(problems(base({ locales: l('  ') }))).toContain('type.text-invalid');
    expect(problems(base({ locales: l('ok', ['ha\u0000lal']) }))).toContain('type.text-invalid');
    expect(problems(base({ locales: l('ok', ['']) }))).toContain('type.text-invalid');
  });

  it('refuses claim terms the matcher cannot use or that match almost everything (Hassan M1)', () => {
    const withTerm = (term: string): TypeRevisionContent =>
      base({
        locales: {
          en: { ...base().locales.en!, claimTerms: ['halal', term] },
          ar: base().locales.ar!,
        },
      });
    for (const bad of ['\u200b1', ' - ', '!!!', '\u0301', '\u0640', '\u202e', 'ーー', 'e', 'ab']) {
      expect([bad, problems(withTerm(bad))]).toEqual([bad, expect.any(Array)]);
      expect(problems(withTerm(bad)).length).toBeGreaterThan(0);
    }
    expect(problems(withTerm('abc'))).toEqual([]);
    const zzBad = zz({ locales: { zz: { ...zz().locales.zz!, claimTerms: ['зд'] } } });
    expect(problems(zzBad, ['zz'])).toContain('type.claim-term-unmatchable');
  });

  it('refuses bidi, format and line-separator characters in texts (Hassan L1)', () => {
    for (const bad of ['Halal \u202eedivorp', 'Ha\u200blal', 'a\u2028b', 'a\u2029b']) {
      const c = base({
        locales: {
          en: { ...base().locales.en!, name: bad },
          ar: base().locales.ar!,
        },
      });
      expect(problems(c)).toContain('type.text-invalid');
    }
  });

  it('refuses a bad icon key', () => {
    expect(problems(base({ badgeIconKey: '<svg>' }))).toContain('type.badge-icon-invalid');
  });

  it('does not trip on prototype-named locales', () => {
    expect(
      problems(
        base({
          locales: JSON.parse('{"__proto__":{}, "en":null}') as TypeRevisionContent['locales'],
        }),
      ),
    ).toContain('type.locale-missing');
  });
});

describe('classifyTypeRevision', () => {
  it('treats a first revision as not relaxing, with terms changed', () => {
    expect(classifyTypeRevision(null, base())).toEqual({
      relaxations: [],
      claimTermsChanged: true,
    });
  });

  it('publishes a tightening or text-only revision at once', () => {
    const next = base({ requiresDocument: true });
    const c = classifyTypeRevision(base(), next);
    expect(c).toEqual({ relaxations: [], claimTermsChanged: false });
    expect(publicationOf(c)).toBe('publish-now');
  });

  it.each([
    ['auto-approve-enabled', zz({ autoApproveSelfDeclaration: false }), zz()],
    ['document-no-longer-required', base(), base({ requiresDocument: false })],
    ['issuer-registry-no-longer-required', base(), base({ requiresIssuerRegistry: false })],
    ['expiry-no-longer-required', base(), base({ requiresExpiry: false })],
    ['default-basis-relaxed', base({ defaultBasis: 'NOT_APPLICABLE' }), base()],
  ] as const)('flags %s as a relaxation', (code, prev, next) => {
    const c = classifyTypeRevision(prev, next);
    expect(c.relaxations).toContain(code);
    expect(publicationOf(c)).toBe('pending-second-admin');
  });

  it('does not flag the tightening direction of the same settings', () => {
    expect(classifyTypeRevision(base({ requiresDocument: false }), base()).relaxations).toEqual([]);
    expect(
      classifyTypeRevision(base(), base({ defaultBasis: 'NOT_APPLICABLE' })).relaxations,
    ).toEqual([]);
  });

  it('flags a removed term and a dropped locale, and a smaller vocabulary on ZZ (Hassan C2)', () => {
    const fewer = base({
      locales: { en: { ...base().locales.en!, claimTerms: ['halal'] }, ar: base().locales.ar! },
    });
    expect(classifyTypeRevision(base(), fewer)).toEqual({
      relaxations: ['claim-term-removed'],
      claimTermsChanged: true,
    });
    const noAr = base({ locales: { en: base().locales.en! } });
    expect(classifyTypeRevision(base(), noAr).relaxations).toContain('locale-dropped');
    const zzFewer = zz({
      locales: { zz: { ...zz().locales.zz!, claimTerms: ['zedpure'] } },
    });
    expect(classifyTypeRevision(zz(), zzFewer).relaxations).toEqual(['claim-term-removed']);
  });

  it('treats a case or width only edit of a term as no removal', () => {
    const next = base({
      locales: {
        en: { ...base().locales.en!, claimTerms: ['HALAL', 'Halal Certified'] },
        ar: base().locales.ar!,
      },
    });
    expect(classifyTypeRevision(base(), next)).toEqual({
      relaxations: [],
      claimTermsChanged: false,
    });
  });

  it('reports added terms as a change that publishes at once', () => {
    const next = base({
      locales: {
        en: { ...base().locales.en!, claimTerms: ['halal', 'halal certified', 'zabiha'] },
        ar: base().locales.ar!,
      },
    });
    const c = classifyTypeRevision(base(), next);
    expect(c).toEqual({ relaxations: [], claimTermsChanged: true });
    expect(publicationOf(c)).toBe('publish-now');
  });

  it('reports terms of a newly added locale as changed', () => {
    const c = classifyTypeRevision(
      zz(),
      zz({ locales: { ...zz().locales, aa: zz().locales.zz! } }),
    );
    expect(c.claimTermsChanged).toBe(true);
    expect(c.relaxations).toEqual([]);
  });
});

describe('assertSecondAdmin', () => {
  it('refuses the author and accepts another admin', () => {
    expect(assertSecondAdmin('a1', 'a1')).toEqual({
      ok: false,
      error: { code: 'approval.same-admin' },
    });
    expect(assertSecondAdmin('a1', 'a2').ok).toBe(true);
    expect(assertSecondAdmin('', 'a2').ok).toBe(false);
    expect(assertSecondAdmin('a1', ' ').ok).toBe(false);
  });
});
