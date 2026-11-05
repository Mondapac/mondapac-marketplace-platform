import { describe, expect, it } from 'vitest';
import {
  checkForm,
  checkSlug,
  editBody,
  emptyForm,
  googlePreview,
  missingIn,
  parseKeywords,
  suggestSlug,
  textsBody,
  withLocale,
} from './edit-model.ts';

describe('category edit model', () => {
  it('splits keywords on commas and new lines without empties or repeats', () => {
    expect(parseKeywords('rice, Basmati\n rice ,, ')).toEqual(['rice', 'Basmati']);
  });

  it('sends only the languages that have something typed, trimmed', () => {
    let form = withLocale(emptyForm(), 'en', { name: ' Rice ', keywords: 'grain' });
    form = withLocale(form, 'fa', { name: '' });
    expect(textsBody(form)).toEqual({
      en: { name: 'Rice', shortDescription: null, keywords: ['grain'] },
    });
    expect(editBody(form).seo).toEqual({ title: null, description: null, noindex: false });
  });

  it('marks the languages without a name as Missing', () => {
    const form = withLocale(emptyForm(), 'en', { name: 'Rice' });
    expect(missingIn(form, ['en', 'fa', 'ar'])).toEqual(['fa', 'ar']);
  });

  it('needs a name in every required language and in any language that is started', () => {
    expect(checkForm(emptyForm(), ['en'])).toEqual({ 'texts.en.name': 'required' });
    const started = withLocale(withLocale(emptyForm(), 'en', { name: 'Rice' }), 'fa', {
      shortDescription: 'x',
    });
    expect(checkForm(started, ['en'])).toEqual({ 'texts.fa.name': 'required' });
  });

  it('keeps the search words English and within their limits', () => {
    const base = withLocale(emptyForm(), 'en', { name: 'Rice' });
    for (const title of ['برنج', 'お米', 'Рис']) {
      expect(checkForm({ ...base, seoTitle: title }, ['en'])['seo.title']).toBe('english-only');
    }
    expect(checkForm({ ...base, seoTitle: 'x'.repeat(61) }, ['en'])['seo.title']).toBe('format');
    expect(checkForm({ ...base, seoDescription: 'x'.repeat(161) }, ['en'])['seo.description']).toBe(
      'format',
    );
    expect(
      checkForm({ ...base, seoTitle: 'Basmati rice', seoDescription: 'Café' }, ['en']),
    ).toEqual({});
  });

  it('suggests and checks a URL name', () => {
    expect(suggestSlug('Dried Fruit & Nuts!')).toBe('dried-fruit-nuts');
    expect(suggestSlug('برنج')).toBe('');
    expect(checkSlug('')).toBe('required');
    expect(checkSlug('a')).toBe('format');
    expect(checkSlug('Dried-Fruit')).toBe('format');
    expect(checkSlug('dried-fruit')).toBeUndefined();
  });

  it('previews a result from the search words, else from the name and short description', () => {
    const input = {
      host: 'www.example.com',
      slug: 'rice',
      seoTitle: '',
      seoDescription: '',
      name: 'Rice',
      shortDescription: 'Long grain',
    };
    expect(googlePreview(input)).toEqual({
      title: 'Rice',
      url: 'www.example.com/c/rice',
      description: 'Long grain',
    });
    const long = googlePreview({ ...input, seoTitle: 'x'.repeat(80) });
    expect(long.title).toHaveLength(60);
    expect(long.title.endsWith('…')).toBe(true);
  });
});
