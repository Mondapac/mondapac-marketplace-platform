import type { Id } from '@mondapac/shared-kernel';
import {
  canDiscard,
  isCategorySlug,
  levelOf,
  parseCategorySeo,
  parseCategoryTexts,
  planHide,
  planReorder,
  planShow,
  siblingNameClashes,
  type EditableCategory,
} from './category-edit';

const cat = (n: number): Id<'Category'> =>
  `01990000-0000-7000-8000-${(0xe00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;

const node = (
  n: number,
  parent: number | null,
  patch: Partial<EditableCategory> = {},
): EditableCategory => ({
  id: cat(n),
  parentId: parent === null ? null : cat(parent),
  slug: `c${n}`,
  status: 'active',
  hiddenById: null,
  position: n,
  version: 1,
  revisionNo: 1,
  createdByKind: 'admin',
  showInMenu: true,
  imageId: null,
  seo: { title: null, description: null, noindex: false },
  texts: [{ locale: 'en', name: `Category ${n}`, shortDescription: null, keywords: [] }],
  ...patch,
});

const RULES = { supported: ['en', 'fa', 'ar'], required: ['en'] };

describe('parseCategoryTexts', () => {
  it('reads a name, description and keywords per locale and skips an empty locale', () => {
    const answer = parseCategoryTexts(
      {
        en: { name: 'Rice', shortDescription: 'Long grain', keywords: ['basmati', 'jasmine'] },
        fa: { name: 'برنج' },
        ar: {},
      },
      RULES,
    );
    expect(answer).toEqual({
      ok: true,
      value: [
        {
          locale: 'en',
          name: 'Rice',
          shortDescription: 'Long grain',
          keywords: ['basmati', 'jasmine'],
        },
        { locale: 'fa', name: 'برنج', shortDescription: null, keywords: [] },
      ],
    });
  });

  it('requires the required locales, naming the paths', () => {
    expect(parseCategoryTexts({ fa: { name: 'برنج' } }, RULES)).toEqual({
      ok: false,
      error: {
        code: 'category.required-locale-missing',
        fields: [{ path: 'texts.en.name', code: 'required' }],
      },
    });
  });

  it.each([
    [
      'a locale outside the Market',
      { en: { name: 'A' }, de: { name: 'B' } },
      'texts.de',
      'locale-unsupported',
    ],
    [
      'a description without a name',
      { en: { name: 'A' }, fa: { shortDescription: 'x' } },
      'texts.fa.name',
      'required',
    ],
    ['a name with outer space', { en: { name: ' A' } }, 'texts.en.name', 'format'],
    ['a name over 120 characters', { en: { name: 'a'.repeat(121) } }, 'texts.en.name', 'format'],
    ['a control character', { en: { name: 'A\u0007' } }, 'texts.en.name', 'format'],
    ['a bidi override', { en: { name: 'A‮B' } }, 'texts.en.name', 'format'],
    [
      'a description over 300',
      { en: { name: 'A', shortDescription: 'a'.repeat(301) } },
      'texts.en.shortDescription',
      'format',
    ],
    [
      'more than 20 keywords',
      { en: { name: 'A', keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) } },
      'texts.en.keywords',
      'format',
    ],
    [
      'a keyword over 40',
      { en: { name: 'A', keywords: ['k'.repeat(41)] } },
      'texts.en.keywords.0',
      'format',
    ],
    [
      'a repeated keyword',
      { en: { name: 'A', keywords: ['Rice', 'rice'] } },
      'texts.en.keywords.1',
      'repeated',
    ],
    ['an unknown key', { en: { name: 'A', colour: 'red' } }, 'texts.en.colour', 'unknown'],
  ])('refuses %s', (_label, raw, path, code) => {
    const answer = parseCategoryTexts(raw, RULES);
    expect(answer.ok).toBe(false);
    if (!answer.ok && answer.error.code === 'validation.failed') {
      expect(answer.error.fields).toContainEqual({ path, code });
    }
  });

  it('refuses a body that is not an object', () => {
    expect(parseCategoryTexts([], RULES).ok).toBe(false);
    expect(parseCategoryTexts(null, RULES).ok).toBe(false);
  });
});

describe('parseCategorySeo', () => {
  it('takes absent as cleared', () => {
    expect(parseCategorySeo(undefined)).toEqual({
      ok: true,
      value: { title: null, description: null, noindex: false },
    });
  });

  it('keeps English title and description and the noindex flag', () => {
    expect(
      parseCategorySeo({ title: 'Rice | Mondapac', description: 'Buy rice', noindex: true }),
    ).toEqual({
      ok: true,
      value: { title: 'Rice | Mondapac', description: 'Buy rice', noindex: true },
    });
  });

  it.each([
    ['a title over 60', { title: 'a'.repeat(61) }, 'seo.title', 'format'],
    ['a description over 160', { description: 'a'.repeat(161) }, 'seo.description', 'format'],
    ['a Persian title', { title: 'برنج' }, 'seo.title', 'english-only'],
    ['an Arabic description', { description: 'أرز' }, 'seo.description', 'english-only'],
    ['a text noindex', { noindex: 'yes' }, 'seo.noindex', 'type'],
    ['an unknown key', { canonical: 'x' }, 'seo.canonical', 'unknown'],
  ])('refuses %s', (_label, raw, path, code) => {
    const answer = parseCategorySeo(raw);
    expect(answer.ok).toBe(false);
    if (!answer.ok && answer.error.code === 'validation.failed') {
      expect(answer.error.fields).toContainEqual({ path, code });
    }
  });
});

describe('isCategorySlug', () => {
  it.each(['rice', 'basmati-rice', 'a1', 'rice-2'])('accepts %s', (slug) => {
    expect(isCategorySlug(slug)).toBe(true);
  });
  it.each(['a', 'Rice', 'rice-', '-rice', 'rice--x', 'ri ce', 'rice/x', 'a'.repeat(81), 7, null])(
    'refuses %s',
    (slug) => {
      expect(isCategorySlug(slug)).toBe(false);
    },
  );
});

describe('levelOf', () => {
  const nodes = [node(1, null), node(2, 1), node(3, 2)];
  const byId = new Map(nodes.map((n) => [n.id as string, n]));
  it('counts a department as level 1', () => {
    expect(levelOf(byId, null)).toBe(0);
    expect(levelOf(byId, cat(1))).toBe(1);
    expect(levelOf(byId, cat(3))).toBe(3);
  });
  it('throws on a missing ancestor', () => {
    expect(() => levelOf(byId, cat(9))).toThrow();
  });
});

describe('siblingNameClashes', () => {
  const nodes = [
    node(1, null),
    node(2, 1, { texts: [{ locale: 'en', name: 'Rice', shortDescription: null, keywords: [] }] }),
  ];
  const text = (name: string) => [{ locale: 'en', name, shortDescription: null, keywords: [] }];
  it('finds the same name under the same parent, ignoring case and width', () => {
    expect(siblingNameClashes(nodes, cat(1), null, text('rice'))).toEqual([
      { path: 'texts.en.name', code: 'sibling-name-taken' },
    ]);
    expect(siblingNameClashes(nodes, cat(1), null, text('ＲＩＣＥ'))).toHaveLength(1);
  });
  it('allows the same name under another parent, and a category keeps its own name', () => {
    expect(siblingNameClashes(nodes, null, null, text('Rice'))).toEqual([]);
    expect(siblingNameClashes(nodes, cat(1), cat(2), text('Rice'))).toEqual([]);
  });
  it('ignores an archived sibling', () => {
    const gone = [node(1, null), node(2, 1, { status: 'archived', texts: text('Rice') })];
    expect(siblingNameClashes(gone, cat(1), null, text('Rice'))).toEqual([]);
  });
});

describe('planHide and planShow', () => {
  // 1 > 2 > 3; 1 > 4 (hidden on its own); 1 > 5 (archived)
  const tree = (extra: Partial<Record<number, Partial<EditableCategory>>> = {}) => [
    node(1, null, extra[1]),
    node(2, 1, extra[2]),
    node(3, 2, extra[3]),
    node(4, 1, { status: 'hidden', ...extra[4] }),
    node(5, 1, { status: 'archived', ...extra[5] }),
  ];

  it('hides the category and its active descendants, each pointing at the hidden category', () => {
    const nodes = tree();
    const plan = planHide(nodes, nodes[0]!);
    expect(plan).toEqual({
      ok: true,
      value: [
        { id: cat(1), status: 'hidden', hiddenById: null },
        { id: cat(2), status: 'hidden', hiddenById: cat(1) },
        { id: cat(3), status: 'hidden', hiddenById: cat(1) },
      ],
    });
  });

  it('refuses to hide a hidden or archived category', () => {
    const nodes = tree();
    expect(planHide(nodes, nodes[3]!)).toEqual({
      ok: false,
      error: { code: 'category.already-hidden' },
    });
    expect(planHide(nodes, nodes[4]!)).toEqual({
      ok: false,
      error: { code: 'category.not-editable' },
    });
  });

  it('shows only what the Hide hid: a child hidden on its own stays hidden', () => {
    const nodes = tree({
      1: { status: 'hidden' },
      2: { status: 'hidden', hiddenById: cat(1) },
      3: { status: 'hidden', hiddenById: cat(1) },
    });
    expect(planShow(nodes, nodes[0]!)).toEqual({
      ok: true,
      value: [
        { id: cat(1), status: 'active', hiddenById: null },
        { id: cat(2), status: 'active', hiddenById: null },
        { id: cat(3), status: 'active', hiddenById: null },
      ],
    });
  });

  it('does not restore a descendant hidden by another cascade', () => {
    const nodes = tree({
      1: { status: 'hidden' },
      2: { status: 'hidden' },
      3: { status: 'hidden', hiddenById: cat(2) },
    });
    const plan = planShow(nodes, nodes[0]!);
    expect(plan).toEqual({ ok: true, value: [{ id: cat(1), status: 'active', hiddenById: null }] });
  });

  it('refuses to show under a hidden parent, a cascaded node, or an active category', () => {
    const nodes = tree({
      1: { status: 'hidden' },
      2: { status: 'hidden', hiddenById: cat(1) },
      3: { status: 'hidden' },
    });
    expect(planShow(nodes, nodes[2]!)).toEqual({
      ok: false,
      error: { code: 'category.parent-hidden' },
    });
    expect(planShow(nodes, nodes[1]!)).toEqual({
      ok: false,
      error: { code: 'category.parent-hidden' },
    });
    expect(planShow(tree(), tree()[0]!)).toEqual({
      ok: false,
      error: { code: 'category.not-hidden' },
    });
  });

  it('refuses a cascade over 500 categories', () => {
    const wide = [node(1, null), ...Array.from({ length: 501 }, (_, i) => node(i + 2, 1))];
    expect(planHide(wide, wide[0]!)).toEqual({
      ok: false,
      error: { code: 'category.cascade-too-large', max: 500 },
    });
  });
});

describe('planReorder', () => {
  const nodes = [
    node(1, null),
    node(2, 1, { position: 0 }),
    node(3, 1, { position: 4, status: 'hidden' }),
    node(4, 1, { position: 5, status: 'archived' }),
    node(5, 1, { position: 7 }),
  ];
  it('picks the neighbour among live siblings, skipping an archived one', () => {
    expect(planReorder(nodes, nodes[1]!, 'down')).toEqual({ ok: true, value: nodes[2] });
    expect(planReorder(nodes, nodes[4]!, 'up')).toEqual({ ok: true, value: nodes[2] });
  });
  it('refuses at the edges', () => {
    expect(planReorder(nodes, nodes[1]!, 'up')).toEqual({
      ok: false,
      error: { code: 'category.reorder-edge' },
    });
    expect(planReorder(nodes, nodes[4]!, 'down')).toEqual({
      ok: false,
      error: { code: 'category.reorder-edge' },
    });
  });
});

describe('canDiscard', () => {
  const target = node(2, 1, { status: 'hidden' });
  const nodes = [node(1, null), target];
  const clean = { everShown: false, productRevisions: 0 };
  it('allows a hidden admin category never shown, with no child and no product revision', () => {
    expect(canDiscard(nodes, target, clean)).toBe(true);
  });
  it.each([
    ['an active category', { ...target, status: 'active' as const }, clean],
    ['a seeded category', { ...target, createdByKind: 'seed' as const }, clean],
    ['one that was shown', target, { ...clean, everShown: true }],
    ['one a product revision named', target, { ...clean, productRevisions: 1 }],
  ])('refuses %s', (_label, subject, facts) => {
    expect(canDiscard(nodes, subject, facts)).toBe(false);
  });
  it('refuses a category with a child', () => {
    expect(canDiscard([...nodes, node(3, 2)], target, clean)).toBe(false);
  });
});
