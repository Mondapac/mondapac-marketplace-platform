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

  it('refuses terms padded by leet punctuation, and invisible or blank text (Hassan M1, L1)', () => {
    const withTerm = (term: string): TypeRevisionContent =>
      base({
        locales: {
          en: { ...base().locales.en!, claimTerms: ['halal', term] },
          ar: base().locales.ar!,
        },
      });
    for (const bad of ['a!!', 'a $$', 'a ##', 'a@@', '1 !!', 'à!!']) {
      expect([bad, problems(withTerm(bad)).length > 0]).toEqual([bad, true]);
    }
    for (const bad of ['\u3164', '\uffa0', '\u2800', 'Hal\u034fal', 'a\u0301\u0302\u0303\u0304b']) {
      const c = base({
        locales: { en: { ...base().locales.en!, name: bad }, ar: base().locales.ar! },
      });
      expect([bad, problems(c).length > 0]).toEqual([bad, true]);
    }
  });

  it('keeps the zero-width non-joiner Persian and Arabic need', () => {
    const fa = zz({
      locales: {
        zz: {
          name: 'می\u200cخواهم',
          customerDescription: 'نیم\u200cفاصله',
          claimTerms: ['می\u200cخواهم'],
        },
      },
    });
    expect(problems(fa, ['zz'])).toEqual([]);
  });

  it('refuses a revision with no claim term in any locale (Hassan)', () => {
    const none = base({
      locales: {
        en: { ...base().locales.en!, claimTerms: [] },
        ar: { ...base().locales.ar!, claimTerms: [] },
      },
    });
    expect(problems(none)).toEqual(['type.claim-terms-missing']);
    const zzNone = zz({ locales: { zz: { ...zz().locales.zz!, claimTerms: [] } } });
    expect(problems(zzNone, ['zz'])).toEqual(['type.claim-terms-missing']);
    // One locale with terms is enough; the other may stay empty.
    const one = base({
      locales: { en: base().locales.en!, ar: { ...base().locales.ar!, claimTerms: [] } },
    });
    expect(problems(one)).toEqual([]);
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

describe('classifyTypeRevision, further cases (Sajad)', () => {
  it('does not flag the tightening direction of the other settings', () => {
    expect(
      classifyTypeRevision(zz(), zz({ autoApproveSelfDeclaration: false })).relaxations,
    ).toEqual([]);
    expect(classifyTypeRevision(base({ requiresExpiry: false }), base()).relaxations).toEqual([]);
    expect(
      classifyTypeRevision(base({ requiresIssuerRegistry: false }), base()).relaxations,
    ).toEqual([]);
  });

  it('flags a swapped term as a removal and a change, on AU and ZZ', () => {
    const swapped = base({
      locales: {
        en: { ...base().locales.en!, claimTerms: ['halal', 'zabiha'] },
        ar: base().locales.ar!,
      },
    });
    expect(classifyTypeRevision(base(), swapped)).toEqual({
      relaxations: ['claim-term-removed'],
      claimTermsChanged: true,
    });
    const zzSwap = zz({
      locales: { zz: { ...zz().locales.zz!, claimTerms: ['zedpure', 'зед ясно'] } },
    });
    expect(classifyTypeRevision(zz(), zzSwap).relaxations).toEqual(['claim-term-removed']);
  });

  it('treats a full-width and a Cyrillic case edit as no removal', () => {
    const fw = base({
      locales: {
        en: { ...base().locales.en!, claimTerms: ['ｈａｌａｌ', 'halal certified'] },
        ar: base().locales.ar!,
      },
    });
    expect(classifyTypeRevision(base(), fw).relaxations).toEqual([]);
    const cy = zz({
      locales: { zz: { ...zz().locales.zz!, claimTerms: ['zedpure', 'ЗЕД ЧИСТО'] } },
    });
    expect(classifyTypeRevision(zz(), cy)).toEqual({ relaxations: [], claimTermsChanged: false });
  });

  it('reports a dropped locale: with terms is a change, without terms is not', () => {
    const noAr = base({ locales: { en: base().locales.en! } });
    expect(classifyTypeRevision(base(), noAr).claimTermsChanged).toBe(true);
    const emptyAr = base({
      locales: { en: base().locales.en!, ar: { ...base().locales.ar!, claimTerms: [] } },
    });
    const c = classifyTypeRevision(emptyAr, noAr);
    expect(c.relaxations).toEqual(['locale-dropped']);
    expect(c.claimTermsChanged).toBe(false);
    const zzTwo = zz({ locales: { ...zz().locales, aa: zz().locales.zz! } });
    expect(classifyTypeRevision(zzTwo, zz()).relaxations).toEqual(['locale-dropped']);
  });
});

describe('validateTypeRevision, further cases (Sajad)', () => {
  const problems = (
    c: TypeRevisionContent,
    locales = LOCALES,
    prev: TypeRevisionContent | null = null,
  ) => {
    const r = validateTypeRevision(c, locales, prev);
    return r.ok ? [] : r.error.map((p) => p.code);
  };
  const withEn = (over: Partial<TypeRevisionContent['locales'][string]>): TypeRevisionContent =>
    base({ locales: { en: { ...base().locales.en!, ...over }, ar: base().locales.ar! } });

  it('enforces the text limits', () => {
    expect(problems(withEn({ name: 'x'.repeat(81) }))).toContain('type.text-invalid');
    expect(problems(withEn({ name: 'x'.repeat(80) }))).toEqual([]);
    expect(problems(withEn({ customerDescription: 'x'.repeat(501) }))).toContain(
      'type.text-invalid',
    );
    expect(problems(withEn({ customerDescription: ' ' }))).toContain('type.text-invalid');
    expect(problems(withEn({ claimTerms: ['x'.repeat(101)] }))).toContain('type.text-invalid');
    expect(
      problems(withEn({ claimTerms: Array.from({ length: 201 }, (_, i) => `term${i}`) })),
    ).toContain('type.text-invalid');
  });

  it('refuses an unknown verification mode', () => {
    expect(problems(base({ verificationMode: 'OTHER' as never }))).toContain(
      'type.verification-mode-invalid',
    );
  });

  it('keeps the mode when unchanged and refuses the change in both directions', () => {
    expect(problems(base(), LOCALES, base())).toEqual([]);
    expect(problems(zz(), ['zz'], zz())).toEqual([]);
    expect(problems(base({ locales: zz().locales }), ['zz'], zz())).toContain(
      'type.verification-mode-immutable',
    );
  });

  it('accepts NOT_APPLICABLE as a default and a valid ZZ revision', () => {
    expect(problems(base({ defaultBasis: 'NOT_APPLICABLE' }))).toEqual([]);
    expect(problems(zz(), ['zz'])).toEqual([]);
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
    expect(assertSecondAdmin('a1', 'A1 ').ok).toBe(false);
  });
});
